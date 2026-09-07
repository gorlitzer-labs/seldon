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

import { writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
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
import { claudeStateToActivity } from "../agent-state.js";
import { wantsUnattendedAgents } from "../approvals.js";
import { preAcceptClaudeTrust } from "./trust.js";
import type { AgentActivityState } from "../../agent/event-processor.js";
import { contentPartsToString } from "../../agent/prompts.js";
import { agentEmoji } from "../config.js";
import { deliverInvite, sameApiaryServer } from "../invites.js";
import { readAgentMetrics } from "./jsonl-stats.js";

const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

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

/**
 * Pre-accept Claude Code's first-run onboarding dialogs for this cwd so a
 * background-spawned agent (no human attached to the tmux pane) doesn't hang
 * forever at a blocking prompt.
 *
 * Claude shows two blocking screens during `showSetupScreens()`:
 *
 *   1. "Quick safety check: is this a project you trust?" — gated on
 *      `projects[<realpath>].hasTrustDialogAccepted`. Neither
 *      `--dangerously-skip-permissions` nor `--permission-mode bypassPermissions`
 *      bypasses it (those gate tool calls, not workspace trust).
 *   2. Per-project onboarding hints — gated on `hasCompletedProjectOnboarding`
 *      and `projectOnboardingSeenCount`.
 *
 * Pre-writing these three keys is what claude itself does after the user
 * clicks through. Best-effort: if claude.json is missing or unparseable we
 * silently skip rather than create/corrupt the file. The key MUST be the
 * realpath because claude resolves symlinks before lookup (`/tmp` →
 * `/private/tmp` on macOS).
 */
function pretrustCwd(cwd: string): void {
  try {
    const path = join(homedir(), ".claude.json");
    if (!existsSync(path)) return;
    const real = realpathSync(cwd);
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return;
    const projects = (data.projects ??= {});
    const entry = (projects[real] ??= {});

    const needsWrite =
      entry.hasTrustDialogAccepted !== true ||
      entry.hasCompletedProjectOnboarding !== true ||
      !(typeof entry.projectOnboardingSeenCount === "number" && entry.projectOnboardingSeenCount >= 1);
    if (!needsWrite) return;

    entry.hasTrustDialogAccepted = true;
    entry.hasCompletedProjectOnboarding = true;
    if (!(typeof entry.projectOnboardingSeenCount === "number" && entry.projectOnboardingSeenCount >= 1)) {
      entry.projectOnboardingSeenCount = 1;
    }

    // Atomic write so a concurrent claude reading the file never sees partial JSON
    const tmpPath = `${path}.apiary-${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, path);
  } catch {
    // Don't block agent spawn on a settings hiccup
  }
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
  const tabTitle = `${agentEmoji(setup.agentName)} ${setup.agentName} · ${cwdShort}`;

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession, tabTitle);

  // Pre-accept claude's workspace-trust dialog for this cwd. Otherwise
  // background-spawned agents (no human attached to the tmux pane) hang
  // forever at the dialog and never reach the MCP-load step.
  pretrustCwd(process.cwd());

  // Launch claude with MCP config + any passthrough args.
  // --strict-mcp-config so we ignore the user's global MCP servers (playwright,
  // project .mcp.json, etc.). Otherwise the agent pays tool-schema tax on
  // every request for tools it will never call — measured 17K tokens of
  // unused schema vs 24K of actual conversation in one real session.
  // Permission prompts are skipped for every apiary agent, not just
  // wizard-spawned ones. An agent in a room has nobody watching its pane, so a
  // prompt is a permanent stall — it cannot call apiary__join_room, cannot
  // answer, and from the room's side looks like it is thinking. Opt out with
  // APIARY_AGENT_APPROVALS=ask.
  // Claude's trust dialog is not skippable by any flag, so pre-record the
  // acceptance for this agent's cwd or it stalls on a modal nobody will see.
  if (wantsUnattendedAgents()) {
    const trust = preAcceptClaudeTrust(process.cwd());
    if (trust === "failed" && !options.background) {
      console.log("Note: could not pre-accept Claude's folder-trust dialog — the agent may ask once.");
    }
  }

  const extraArgs = options.extraArgs ?? [];
  const flags = [`claude --mcp-config ${mcpConfigPath} --strict-mcp-config`];
  // Don't duplicate it if the caller already passed it themselves.
  if (wantsUnattendedAgents() && !extraArgs.includes(SKIP_PERMISSIONS_FLAG)) {
    flags.push(SKIP_PERMISSIONS_FLAG);
  }
  const claudeCmd = [...flags, ...extraArgs].join(" ");
  tmuxSendCommand(tmuxSession, claudeCmd);

  // ── Start event loop + attach ──────────────────────────────────────────

  const bridge = new TmuxBridge(tmuxSession);

  // Start the event loop in the background — no initial injection.
  // The agent joins rooms by calling join_room() when the user tells it to.
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource)
    .catch(() => {}); // Prevent unhandled rejection from crashing the process

  // Activity heartbeat — every ~1.5s, scrape claude's status line ("Sautéed
  // for 12s", "Compacting…", etc.) and push to all connected rooms when it
  // changes. Gives the room TUI live "is the agent stuck or working?" signal
  // instead of just a static green dot.
  let lastActivityLabel: string | null = null;
  let lastState: AgentActivityState | undefined;
  const activityTimer: NodeJS.Timeout = setInterval(() => {
    let label: string | null;
    let state: AgentActivityState | undefined;
    try {
      label = bridge.getActivityLabel();
      state = claudeStateToActivity(bridge.detectState());
    } catch { return; }
    // Report the state as well as the label. A permission prompt shows no
    // activity label at all, so on the label alone the room cannot tell
    // "waiting for you" from "quietly working" — and only one of those ends
    // without the user doing something.
    if (label === lastActivityLabel && state === lastState) return;
    lastActivityLabel = label;
    lastState = state;
    setup.processor.broadcastActivity(label, state).catch(() => { /* best-effort */ });
  }, 1500);
  activityTimer.unref();

  // Metrics heartbeat — every ~10s, re-parse claude's session jsonl to
  // pull last-turn context size. Broadcast only when the context number
  // actually changes (avoid spamming the room on idle ticks).
  let lastBroadcastCtx = -1;
  const metricsTimer: NodeJS.Timeout = setInterval(() => {
    try {
      const m = readAgentMetrics(process.cwd());
      if (!m) return;
      if (m.lastTurnContextTokens === lastBroadcastCtx) return;
      lastBroadcastCtx = m.lastTurnContextTokens;
      setup.processor.broadcastMetrics({
        input_tokens: m.inputTokens,
        output_tokens: m.outputTokens,
        cache_read_tokens: m.cacheReadTokens,
        cache_create_tokens: m.cacheCreateTokens,
        last_ctx_tokens: m.lastTurnContextTokens,
        model: m.lastModel,
      }).catch(() => { /* best-effort */ });
    } catch { /* never crash the runtime on a metrics read */ }
  }, 10_000);
  metricsTimer.unref();

  // Wait for Claude to start, checking the session is still alive
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!tmuxSessionExists(tmuxSession)) {
      console.error("Error: Claude Code exited during startup. Try running again.");
      clearInterval(activityTimer); clearInterval(metricsTimer);
      bridge.stop();
      await setup.cleanup();
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
      resetTerminal();
      return;
    }
  }

  // ── Deliver queued invite (auto-join) ─────────────────────────────────
  // If the wizard background-spawned this agent, ~/.apiary/invites/<name>
  // holds the room's join URL. deliverInvite keeps asking until the agent is
  // really in the room, and only then deletes the file — a CLI still sitting
  // on a trust or onboarding prompt gets another go once it reaches a prompt,
  // instead of losing the URL to a menu that swallowed it.
  const inviteAbort = new AbortController();
  const invitePromise = deliverInvite({
    agentName: setup.agentName,
    deliver: (parts) => bridge.deliver(parts, { dedupe: true }),
    hasJoined: (url) => setup.joinResults.some((jr) => sameApiaryServer(jr.serverUrl, url)),
    signal: inviteAbort.signal,
  }).then((outcome) => {
    // Don't let a failed auto-join be silent — that is exactly how an agent
    // ends up sitting outside the room it was spawned for. The invite is kept
    // on disk, so `apiary room resume <room>` will hand it over again.
    if (outcome === "abandoned" && !options.background) {
      console.log(
        `Note: "${setup.agentName}" did not join the room it was invited to. ` +
        `The invite is still queued — check the pane, then re-run or use "apiary room resume".`,
      );
    }
    return outcome;
  }).catch(() => "cancelled" as const);

  // ── Save session state for resume ──────────────────────────────────────

  saveSession({
    tmuxSession,
    agentName: setup.agentName,
    tmpDir,
    mcpPort,
    pid: process.pid,
  });

  // Background mode: spawned by room create — run silently until SIGTERM.
  if (options.background) {
    // Suppress output so this process doesn't bleed into the parent terminal.
    const noop = (() => true) as unknown as typeof process.stdout.write;
    process.stdout.write = noop;
    process.stderr.write = noop;
    await new Promise<void>((resolve) => {
      process.on("SIGTERM", resolve);
      process.on("SIGINT", resolve);
    });
    clearInterval(activityTimer); clearInterval(metricsTimer);
    inviteAbort.abort();
    await invitePromise;
    bridge.stop();
    await setup.cleanup();
    if (tmuxSessionExists(tmuxSession)) tmuxKillSession(tmuxSession);
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
    clearSession(setup.agentName);
    return;
  }

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
    const noop = (() => true) as any;
    process.stdout.write = noop;
    process.stderr.write = noop;

    // Keep the process alive so the event loop, MCP server, and SSE stay up
    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
  }

  // ── Full cleanup (session ended or process killed) ─────────────────────

  clearInterval(activityTimer); clearInterval(metricsTimer);
  inviteAbort.abort();
  await invitePromise;
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
    // --all is allowed to no-op (rooms may have already cleaned up everything)
    if (all) return;
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
