/**
 * apiary run opencode — client-side agent runtime for OpenCode.
 *
 * Spawns `opencode serve` with OPENCODE_CONFIG_CONTENT to inject the apiary
 * MCP server. The user opens OpenCode's UI, starts a conversation, and tells
 * the agent to join a room URL.
 *
 * Session detection: we subscribe to OpenCode's global SSE event stream and
 * watch for apiary tool call events. Each event carries the sessionID of the
 * calling session — no guessing, no race conditions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";
import {
  saveAgentSession,
  clearAgentSession,
  listAgentSessions,
  isAgentAlive,
  type AgentSession,
} from "../agent-session.js";

export { type AgentRuntimeOptions as RunOpencodeOptions };

export function listOpencodeSessions(): AgentSession[] {
  return listAgentSessions("opencode");
}

export async function runOpencode(options: AgentRuntimeOptions): Promise<void> {
  // ── Pick a port for OpenCode ────────────────────────────────────────────

  const opencodePort = 14096 + Math.floor(Math.random() * 1000);
  const opencodeUrl = `http://127.0.0.1:${opencodePort}`;

  // ── Room → OpenCode session mapping ────────────────────────────────────
  //
  // Each OpenCode session can join different rooms. Lazily detected on first
  // delivery for each room by inspecting session messages for apiary tool calls.

  const roomSessions = new Map<string, string>();   // roomId → OpenCode sessionId

  /** Find the OpenCode session that most recently called an apiary tool. */
  async function findApiarySession(): Promise<string | null> {
    try {
      const res = await fetch(`${opencodeUrl}/session`);
      if (!res.ok) return null;
      // Sessions sorted by time.updated desc — first is most recent
      const sessions = await res.json() as Array<{ id: string; time: { updated: number } }>;

      // Check the most recently updated sessions for apiary tool parts
      for (const sess of sessions.slice(0, 3)) {
        const msgRes = await fetch(`${opencodeUrl}/session/${sess.id}/message`);
        if (!msgRes.ok) continue;
        const messages = await msgRes.json() as Array<{
          parts?: Array<{ type?: string; tool?: string }>;
        }>;
        for (const msg of messages) {
          for (const part of msg.parts ?? []) {
            if (part.type === "tool" && part.tool?.includes("apiary__")) {
              return sess.id;
            }
          }
        }
      }
      // Fallback: most recently updated session
      return sessions.length > 0 ? sessions[0].id : null;
    } catch {
      return null;
    }
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // No --join URLs — the user tells the agent to join from within OpenCode.

  const setup = await setupAgentRuntime({
    ...options,
    joinUrls: undefined,
  });

  // ── Build MCP config for OpenCode ───────────────────────────────────────

  const opencodeConfig = {
    mcp: {
      apiary: {
        type: "remote",
        url: setup.mcpServer.url,
        oauth: false,
      },
    },
  };

  // ── Spawn OpenCode in headless mode ─────────────────────────────────────

  const extraArgs = options.extraArgs ?? [];
  const opencodeArgs = ["serve", "--port", String(opencodePort), ...extraArgs];

  console.log("Launching OpenCode...");

  let child: ChildProcess;
  try {
    child = spawn("opencode", opencodeArgs, {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error("Error: opencode is required but not found. Install it from https://opencode.ai");
    await setup.cleanup();
    process.exit(1);
  }

  // Forward stderr to console for visibility
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let childExited = false;
  child.on("exit", () => { childExited = true; });

  child.on("error", async () => {
    console.error("Error: failed to start opencode. Is it installed?");
    await setup.cleanup();
    process.exit(1);
  });

  // ── Wait for OpenCode to be ready ───────────────────────────────────────

  const ready = await pollForReady(opencodeUrl, 30_000);
  if (!ready) {
    console.error("OpenCode did not become ready within 30 seconds.");
    child.kill();
    await setup.cleanup();
    process.exit(1);
  }

  console.log(`  OpenCode running on ${opencodeUrl}`);

  // Register session so `apiary ps` / `apiary stop` can see it.
  saveAgentSession({
    runtime: "opencode",
    agentName: setup.agentName,
    pid: process.pid,
    childPid: child.pid,
  });

  // ── Build deliver callback ──────────────────────────────────────────────
  //
  // OpenCode's POST /session/:id/message uses Hono stream() — headers (200)
  // arrive immediately but the LLM runs inside the stream callback. We MUST
  // consume the response body (await res.text()) to block until the LLM
  // finishes, preserving the EventProcessor's _processing lock.

  async function deliver(parts: ContentPart[]): Promise<void> {
    const roomId = setup.processor.currentContextRoomId;
    if (!roomId) return;

    // Lazy session detection: look up on first delivery for this room
    if (!roomSessions.has(roomId)) {
      const sid = await findApiarySession();
      if (!sid) return;
      roomSessions.set(roomId, sid);
      console.log(`  Linked room ${roomId} → session ${sid}`);
    }
    const targetSession = roomSessions.get(roomId)!;

    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    try {
      const res = await fetch(`${opencodeUrl}/session/${targetSession}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      });
      await res.text();
    } catch {
      // OpenCode may have exited
    }
  }

  // ── Start the event loop ────────────────────────────────────────────────
  // No initialParts — the user drives the conversation from OpenCode's UI.

  const eventLoopPromise = setup.processor.run(deliver, setup.wrappedSource);

  console.log(`\n  OpenCode agent running.`);
  console.log(`  To watch: opencode attach ${opencodeUrl}\n`);

  // ── Block until child exits or Ctrl+C ───────────────────────────────────

  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", resolve);
  });

  const signalPromise = new Promise<void>((resolve) => {
    const handler = () => { resolve(); };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });

  await Promise.race([exitPromise, signalPromise]);

  // ── Cleanup ─────────────────────────────────────────────────────────────

  if (!childExited) {
    child.kill();
  }
  await setup.cleanup();
  clearAgentSession("opencode", setup.agentName);

  console.log("Disconnected.");
}

// ── Stop ────────────────────────────────────────────────────────────────────

export async function stopOpencode(name?: string, all?: boolean): Promise<void> {
  const sessions = listOpencodeSessions();
  if (sessions.length === 0) {
    if (all) return;
    console.error("No active OpenCode sessions.");
    process.exit(1);
  }

  if (all) {
    for (const s of sessions) stopOpencodeSession(s);
    return;
  }

  let session: AgentSession | undefined;
  if (name) {
    session = sessions.find((s) => s.agentName === name);
    if (!session) {
      console.error(`No active OpenCode session named "${name}". Active sessions:`);
      for (const s of sessions) console.error(`  - ${s.agentName}`);
      process.exit(1);
    }
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    console.error("Multiple active OpenCode sessions. Use --name or --all:");
    for (const s of sessions) console.error(`  - ${s.agentName}`);
    process.exit(1);
  }

  stopOpencodeSession(session);
}

function stopOpencodeSession(session: AgentSession): void {
  // Kill the opencode child first so it doesn't outlive its parent runtime.
  if (session.childPid) {
    try { process.kill(session.childPid, "SIGTERM"); } catch { /* ok */ }
  }
  if (isAgentAlive(session)) {
    try { process.kill(session.pid, "SIGTERM"); } catch { /* ok */ }
  }
  clearAgentSession("opencode", session.agentName);
  console.log(`Stopped "${session.agentName}".`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function pollForReady(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/session/status`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
