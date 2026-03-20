/**
 * apiary claude — client-side agent runtime for Claude Code.
 *
 * Uses the shared runtime setup (EventProcessor, MCP server)
 * then adds Claude-specific pieces: tmux session + TmuxBridge delivery.
 *
 * Claude Code connects to the runtime MCP server via a stdio bridge
 * (Claude's HTTP MCP transport requires OAuth, which hangs on localhost).
 * The agent joins rooms by calling join_room() — no auto-injection needed.
 */

import { writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
  resetTerminal,
} from "../tmux.js";
import { TmuxBridge } from "./tmux-bridge.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";
import { contentPartsToString } from "../../agent/prompts.js";

export { type AgentRuntimeOptions as RunClaudeOptions };

// ── Session state persistence ─────────────────────────────────────────────────

const SESSION_DIR = join(homedir(), ".apiary", "sessions");

interface PersistedSession {
  tmuxSession: string;
  agentName: string;
  tmpDir: string;
  mcpPort: string;
  pid: number;
}

function sessionFilePath(name: string): string {
  return join(SESSION_DIR, `claude_${name}.json`);
}

function saveSession(session: PersistedSession): void {
  const dir = SESSION_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(sessionFilePath(session.agentName), JSON.stringify(session, null, 2));
}

function loadSession(name: string): PersistedSession | null {
  const path = sessionFilePath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function clearSession(name: string): void {
  const path = sessionFilePath(name);
  try { rmSync(path); } catch { /* ok */ }
}

/** List all active Claude sessions. */
export function listClaudeSessions(): PersistedSession[] {
  if (!existsSync(SESSION_DIR)) return [];
  const files = readdirSync(SESSION_DIR) as string[];
  const sessions: PersistedSession[] = [];
  for (const f of files) {
    if (!f.startsWith("claude_") || !f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8"));
      sessions.push(s);
    } catch { /* skip */ }
  }
  return sessions;
}

/**
 * Stdio-to-HTTP bridge script. Written to a temp file and spawned by Claude Code
 * as an MCP stdio server. Proxies JSON-RPC messages to the runtime HTTP MCP server.
 *
 * The HTTP MCP server returns SSE-formatted responses (event: message\ndata: {...}).
 * The bridge extracts the JSON from data: lines and writes raw JSON-RPC to stdout.
 */
// CommonJS (.cjs) for minimal startup latency — ESM requires module parsing which
// can exceed Claude Code's MCP handshake timeout on first run.
const MCP_STDIO_BRIDGE = [
  '#!/usr/bin/env node',
  '"use strict";',
  'const { createInterface } = require("readline");',
  'const url = `http://127.0.0.1:${process.argv[2]}/mcp`;',
  'const rl = createInterface({ input: process.stdin });',
  '(async () => {',
  '  for await (const line of rl) {',
  '    if (!line.trim()) continue;',
  '    try {',
  '      const res = await fetch(url, {',
  '        method: "POST",',
  '        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },',
  '        body: line,',
  '      });',
  '      if (res.status === 202) continue;',
  '      const body = await res.text();',
  '      for (const bl of body.split("\\n")) {',
  '        const m = bl.match(/^data: (.+)/);',
  '        if (m) process.stdout.write(m[1] + "\\n");',
  '      }',
  '    } catch {',
  '      process.exit(1);',
  '    }',
  '  }',
  '})();',
].join('\n');

export async function runClaude(options: AgentRuntimeOptions): Promise<void> {
  // ── Headless mode — skip tmux, deliver events as plain text to stdout ────

  if (options.headless) {
    const setup = await setupAgentRuntime(options);

    const deliver = async (parts: Parameters<typeof contentPartsToString>[0]) => {
      const text = contentPartsToString(parts);
      if (text.trim()) process.stdout.write(text + "\n");
    };

    const eventLoopPromise = setup.processor
      .run(deliver, setup.wrappedSource, setup.initialParts)
      .catch(() => {});

    process.stderr.write(`MCP server: ${setup.mcpServer.url}\n`);

    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });

    await setup.cleanup();
    await eventLoopPromise;
    return;
  }

  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  // ── Resume existing session ─────────────────────────────────────────────

  if (options.resume) {
    return resumeClaude(options);
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // Don't pass joinUrls — Claude Code agents join rooms manually via join_room()

  const setup = await setupAgentRuntime({ ...options, joinUrls: undefined });

  // ── Write MCP stdio bridge + config ────────────────────────────────────

  const tmpDir = mkdtempSync(join(tmpdir(), "apiary_agent_"));

  const bridgePath = join(tmpDir, "mcp-bridge.cjs");
  writeFileSync(bridgePath, MCP_STDIO_BRIDGE);
  chmodSync(bridgePath, 0o755);

  const mcpPort = new URL(setup.mcpServer.url).port;
  const mcpConfigPath = join(tmpDir, "mcp.json");

  // Use process.execPath (absolute path to Node) so the bridge works regardless
  // of whether `node` is in the tmux session's PATH.
  const mcpConfig = {
    mcpServers: {
      apiary: {
        type: "stdio",
        command: process.execPath,
        args: [bridgePath, mcpPort],
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // ── Create tmux session + launch Claude Code ────────────────────────────

  const tmuxSession = `apiary_${setup.agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  const home = homedir();
  const cwdFull = process.cwd();
  const cwdShort = cwdFull.startsWith(home) ? "~" + cwdFull.slice(home.length) : cwdFull;
  const bees = [
    "🐝", "🐛", "🦋", "🐞", "🪲", "🐜", "🦗", "🪳", "🦂", "🕷️",
    "🪰", "🦟", "🐌", "🐙", "🦑", "🦀", "🪱", "🦠", "🧬", "🔬",
  ];
  const bee = bees[Math.floor(Math.random() * bees.length)];
  const tabTitle = `${bee} ${setup.agentName} · ${cwdShort}`;

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession, tabTitle);

  // Launch claude with MCP config + any passthrough args
  const extraArgs = options.extraArgs ?? [];
  const claudeCmd = [`claude --mcp-config ${mcpConfigPath}`, ...extraArgs].join(" ");
  tmuxSendCommand(tmuxSession, claudeCmd);

  // ── Start event loop + attach ──────────────────────────────────────────

  const bridge = new TmuxBridge(tmuxSession);

  // Start the event loop in the background — no initial injection.
  // The agent joins rooms by calling join_room() when the user tells it to.
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource)
    .catch(() => {}); // Prevent unhandled rejection from crashing the process

  // Wait for Claude to start, checking the session is still alive
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!tmuxSessionExists(tmuxSession)) {
      console.error("Error: Claude Code exited during startup. Try running again.");
      bridge.stop();
      await setup.cleanup();
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
      resetTerminal();
      return;
    }
  }

  // ── Save session state for resume ──────────────────────────────────────

  saveSession({
    tmuxSession,
    agentName: setup.agentName,
    tmpDir,
    mcpPort,
    pid: process.pid,
  });

  console.log("Attaching...");
  console.log(`(Ctrl+B D to detach — resume with: apiary claude ${setup.agentName} --resume)\n`);

  try {
    await tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── On detach: keep running in background ──────────────────────────────

  if (tmuxSessionExists(tmuxSession)) {
    console.log(`"${setup.agentName}" still running in background.`);
    console.log(`  Resume:  apiary claude ${setup.agentName} --resume`);
    console.log(`  Stop:    apiary stop ${setup.agentName}`);

    // Silence stdout/stderr so background process doesn't bleed
    // into other terminals (e.g. another agent's tmux session)
    const devNull = await import("node:fs").then(fs => fs.openSync("/dev/null", "w"));
    process.stdout.write = process.stderr.write = (() => true) as any;
    try { process.stdout.fd !== undefined && (process as any).stdout._handle = null; } catch {}
    try { process.stderr.fd !== undefined && (process as any).stderr._handle = null; } catch {}

    // Keep the process alive so the event loop, MCP server, and SSE stay up
    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
  }

  // ── Full cleanup (session ended or process killed) ─────────────────────

  bridge.stop();
  await setup.cleanup();
  if (tmuxSessionExists(tmuxSession)) tmuxKillSession(tmuxSession);
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  clearSession(setup.agentName);
  resetTerminal();
}

// ── Resume ──────────────────────────────────────────────────────────────────

async function resumeClaude(options: AgentRuntimeOptions): Promise<void> {
  const name = options.name;

  // Find session to resume
  const sessions = listClaudeSessions();
  if (sessions.length === 0) {
    console.error("No active Claude sessions to resume.");
    process.exit(1);
  }

  let session: PersistedSession | undefined;
  if (name) {
    session = sessions.find((s) => s.agentName === name);
    if (!session) {
      console.error(`No active session named "${name}". Active sessions:`);
      for (const s of sessions) console.error(`  - ${s.agentName}`);
      process.exit(1);
    }
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    console.error("Multiple active sessions. Specify which one with --name:");
    for (const s of sessions) console.error(`  - ${s.agentName}`);
    process.exit(1);
  }

  // Verify tmux session is alive
  if (!tmuxSessionExists(session.tmuxSession)) {
    console.error(`Session "${session.agentName}" tmux session is gone. Cleaning up.`);
    clearSession(session.agentName);
    process.exit(1);
  }

  // Verify background process is alive
  try {
    process.kill(session.pid, 0);
  } catch {
    console.error(`Session "${session.agentName}" background process (pid ${session.pid}) is gone. Cleaning up.`);
    tmuxKillSession(session.tmuxSession);
    clearSession(session.agentName);
    try { rmSync(session.tmpDir, { recursive: true }); } catch { /* ok */ }
    process.exit(1);
  }

  console.log(`Resuming session "${session.agentName}"...\n`);

  try {
    await tmuxAttach(session.tmuxSession);
  } catch {
    // User detached
  }

  if (tmuxSessionExists(session.tmuxSession)) {
    console.log(`"${session.agentName}" still running in background.`);
    console.log(`  Resume:  apiary claude ${session.agentName} --resume`);
    console.log(`  Stop:    apiary stop ${session.agentName}`);
  }
}

// ── Stop ────────────────────────────────────────────────────────────────────

export async function stopClaude(name?: string, all?: boolean): Promise<void> {
  const sessions = listClaudeSessions();
  if (sessions.length === 0) {
    console.error("No active Claude sessions.");
    process.exit(1);
  }

  if (all) {
    for (const s of sessions) {
      stopSession(s);
    }
    return;
  }

  let session: PersistedSession | undefined;
  if (name) {
    session = sessions.find((s) => s.agentName === name);
    if (!session) {
      console.error(`No active session named "${name}". Active sessions:`);
      for (const s of sessions) console.error(`  - ${s.agentName}`);
      process.exit(1);
    }
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    console.error("Multiple active sessions. Use --name or --all:");
    for (const s of sessions) console.error(`  - ${s.agentName}`);
    process.exit(1);
  }

  stopSession(session);
}

function stopSession(session: PersistedSession): void {
  // Kill tmux session first (prevents orphaned panes with broken state)
  if (tmuxSessionExists(session.tmuxSession)) {
    tmuxKillSession(session.tmuxSession);
  }

  // Then signal the background process
  try {
    process.kill(session.pid, "SIGTERM");
  } catch {
    // Process already gone
  }

  // Clean up temp files
  try { rmSync(session.tmpDir, { recursive: true }); } catch { /* ok */ }

  clearSession(session.agentName);
  resetTerminal();
  console.log(`Stopped "${session.agentName}".`);
}
