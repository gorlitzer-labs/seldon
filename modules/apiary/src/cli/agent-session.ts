/**
 * Shared session registry for client-side agent runtimes (claude, codex, opencode).
 *
 * Each runtime persists a small JSON file in ~/.apiary/sessions/<runtime>_<name>.json
 * so `apiary ps` and `apiary stop` can see and tear them down.
 */

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SESSION_DIR = join(homedir(), ".apiary", "sessions");

export type AgentRuntime = "claude" | "codex" | "opencode";

export interface AgentSession {
  runtime: AgentRuntime;
  agentName: string;
  pid: number;
  /** Tmux session (codex/claude) — undefined for opencode. */
  tmuxSession?: string;
  /** Tmp dir to remove on stop. */
  tmpDir?: string;
  /** OpenCode-style child pid that needs a separate kill. */
  childPid?: number;
}

function sessionPath(runtime: AgentRuntime, name: string): string {
  return join(SESSION_DIR, `${runtime}_${name}.json`);
}

export function saveAgentSession(session: AgentSession): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(sessionPath(session.runtime, session.agentName), JSON.stringify(session, null, 2));
}

export function clearAgentSession(runtime: AgentRuntime, name: string): void {
  try { rmSync(sessionPath(runtime, name)); } catch { /* ok */ }
}

export function listAgentSessions(runtime: AgentRuntime): AgentSession[] {
  if (!existsSync(SESSION_DIR)) return [];
  const prefix = `${runtime}_`;
  const sessions: AgentSession[] = [];
  for (const f of readdirSync(SESSION_DIR) as string[]) {
    if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
    try {
      sessions.push(JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8")));
    } catch { /* skip */ }
  }
  return sessions;
}

/** True if the recorded pid is still alive. */
export function isAgentAlive(session: AgentSession): boolean {
  try { process.kill(session.pid, 0); return true; } catch { return false; }
}
