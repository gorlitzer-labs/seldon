/**
 * apiary run codex — client-side agent runtime for OpenAI Codex CLI.
 *
 * Uses the shared runtime setup (EventProcessor, MCP server)
 * then adds Codex-specific pieces: tmux session + CodexTmuxBridge delivery.
 *
 * Codex connects to the runtime MCP server natively via config.toml
 * (no stdio bridge needed — Codex supports remote MCP servers via URL).
 * The agent joins rooms by calling join_room() — no auto-injection needed.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";

import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
  resetTerminal,
} from "../tmux.js";
import { CodexTmuxBridge } from "./tmux-bridge.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";
import { contentPartsToString } from "../../agent/prompts.js";
import { agentEmoji } from "../config.js";
import { deliverInvite, sameApiaryServer } from "../invites.js";
import {
  clearCodexProfile,
  prepareCodexLaunch,
  pruneCodexProfiles,
} from "./launch.js";
import {
  saveAgentSession,
  clearAgentSession,
  listAgentSessions,
  isAgentAlive,
  type AgentSession,
} from "../agent-session.js";

export { type AgentRuntimeOptions as RunCodexOptions };

export function listCodexSessions(): AgentSession[] {
  return listAgentSessions("codex");
}

/** Check if codex CLI is installed and available. */
function codexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runCodex(options: AgentRuntimeOptions): Promise<void> {
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

  if (!codexAvailable()) {
    console.error("Error: codex is required but not found. Install it with: npm install -g @openai/codex");
    process.exit(1);
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // Don't pass joinUrls — Codex agents join rooms manually via join_room()

  const setup = await setupAgentRuntime({ ...options, joinUrls: undefined });

  // ── Codex MCP wiring ────────────────────────────────────────────────────
  // Codex supports remote MCP servers natively, so no stdio bridge is needed
  // (unlike Claude Code, which has an OAuth bug). apiary declares itself in a
  // config profile layered over the user's real Codex home, so the agent keeps
  // their credentials, model and project trust — see launch.ts.

  const mcpPort = new URL(setup.mcpServer.url).port;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  // ── Create tmux session + launch Codex ──────────────────────────────────

  const tmuxSession = `apiary_${setup.agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  const home = homedir();
  const cwdFull = process.cwd();
  const cwdShort = cwdFull.startsWith(home) ? "~" + cwdFull.slice(home.length) : cwdFull;
  const tabTitle = `${agentEmoji(setup.agentName)} ${setup.agentName} · ${cwdShort}`;

  console.log("Launching Codex...");
  tmuxCreateSession(tmuxSession, tabTitle);

  // Sweep profiles orphaned by a runtime that was killed before it could clean
  // up. "Live" means the process is actually alive — a stale session record
  // would otherwise keep a dead agent's profile around forever. This agent
  // counts as live so a concurrent launch cannot sweep what we are about to
  // write, and vice versa.
  pruneCodexProfiles([
    setup.agentName,
    ...listCodexSessions().filter(isAgentAlive).map((s) => s.agentName),
  ]);
  const { command } = prepareCodexLaunch(setup.agentName, mcpUrl, options.extraArgs ?? []);
  tmuxSendCommand(tmuxSession, command);

  // ── Start event loop + attach ──────────────────────────────────────────

  const bridge = new CodexTmuxBridge(tmuxSession);

  // Start the event loop in the background — no initial injection.
  // The agent joins rooms by calling join_room() when the user tells it to.
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource)
    .catch(() => {}); // Prevent unhandled rejection from crashing the process

  // Wait for Codex to start, checking the session is still alive
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!tmuxSessionExists(tmuxSession)) {
      console.error("Error: Codex exited during startup. Try running again.");
      clearCodexProfile(setup.agentName);
      bridge.stop();
      await setup.cleanup();
      resetTerminal();
      return;
    }
  }

  // Register session so `apiary ps` / `apiary stop` can see it.
  saveAgentSession({
    runtime: "codex",
    agentName: setup.agentName,
    pid: process.pid,
    tmuxSession,
  });

  // ── Deliver queued invite (auto-join) ─────────────────────────────────
  // If the wizard background-spawned this agent, ~/.apiary/invites/<name>
  // holds the room's join URL. deliverInvite keeps asking until the agent is
  // really in the room, and only then deletes the file — a Codex that boots
  // into a sign-in or onboarding screen gets another go once it reaches a
  // prompt, instead of losing the URL to a menu that swallowed it.
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
    inviteAbort.abort();
    await invitePromise;
    bridge.stop();
    await setup.cleanup();
    if (tmuxSessionExists(tmuxSession)) tmuxKillSession(tmuxSession);
    clearCodexProfile(setup.agentName);
    clearAgentSession("codex", setup.agentName);
    return;
  }

  console.log("Attaching to Codex session...\n");

  try {
    await tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  inviteAbort.abort();
  await invitePromise;
  bridge.stop();
  await setup.cleanup();
  tmuxKillSession(tmuxSession);
  clearCodexProfile(setup.agentName);
  clearAgentSession("codex", setup.agentName);
  resetTerminal();

  console.log("Disconnected.");
}

// ── Stop ────────────────────────────────────────────────────────────────────

export async function stopCodex(name?: string, all?: boolean): Promise<void> {
  const sessions = listCodexSessions();
  if (sessions.length === 0) {
    if (all) return;
    console.error("No active Codex sessions.");
    process.exit(1);
  }

  if (all) {
    for (const s of sessions) stopCodexSession(s);
    return;
  }

  let session: AgentSession | undefined;
  if (name) {
    session = sessions.find((s) => s.agentName === name);
    if (!session) {
      console.error(`No active Codex session named "${name}". Active sessions:`);
      for (const s of sessions) console.error(`  - ${s.agentName}`);
      process.exit(1);
    }
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    console.error("Multiple active Codex sessions. Use --name or --all:");
    for (const s of sessions) console.error(`  - ${s.agentName}`);
    process.exit(1);
  }

  stopCodexSession(session);
}

function stopCodexSession(session: AgentSession): void {
  if (session.tmuxSession && tmuxSessionExists(session.tmuxSession)) {
    tmuxKillSession(session.tmuxSession);
  }
  if (isAgentAlive(session)) {
    try { process.kill(session.pid, "SIGTERM"); } catch { /* ok */ }
  }
  clearCodexProfile(session.agentName);
  // Sessions recorded by an older apiary still carry a sandboxed CODEX_HOME.
  if (session.tmpDir) {
    try { rmSync(session.tmpDir, { recursive: true }); } catch { /* ok */ }
  }
  clearAgentSession("codex", session.agentName);
  resetTerminal();
  console.log(`Stopped "${session.agentName}".`);
}
