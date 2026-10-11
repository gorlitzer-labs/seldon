/**
 * Codex delivery that never touches the composer.
 *
 * `codex queue --thread <id> --message <text>` hands a message to a running
 * Codex session through Codex itself. Nothing is typed, so none of the
 * composer's own behaviour applies: no paste-vs-typing timing to lose, no
 * `@`-mention popup to open, no Enter to be swallowed selecting a completion.
 * Measured against the message that broke #shipyard on 2026-09-10 it landed
 * intact 4/4 in 1.2–3.3s, where keystroke delivery mangled it.
 *
 * It also queues rather than races: a busy or blocked agent picks the message
 * up when it is ready, so the poll-until-injectable loop the tmux path needs
 * does not apply either.
 *
 * The one thing Codex does not give us is a way to name a session at launch,
 * so the thread has to be recognised after the fact — see findCodexSessionId.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Codex's session store, honouring CODEX_HOME like Codex itself does. */
export function userCodexSessionsDir(codexHome?: string): string {
  return join(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

/** The first line of a rollout file: Codex's own session metadata. */
interface SessionMeta {
  sessionId: string;
  cwd: string;
  startedAt: number;
}

/** Parse a rollout's session_meta record, or null if it is not one. */
export function parseSessionMeta(firstLine: string): SessionMeta | null {
  try {
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta") return null;
    const payload = record.payload ?? {};
    const sessionId = payload.session_id ?? payload.id;
    const startedAt = Date.parse(payload.timestamp ?? "");
    if (typeof sessionId !== "string" || typeof payload.cwd !== "string") return null;
    if (Number.isNaN(startedAt)) return null;
    return { sessionId, cwd: payload.cwd, startedAt };
  } catch {
    return null;
  }
}

/** Every rollout file under the session store, newest mtime first. */
function rolloutFiles(root: string): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        found.push({ path, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

export interface FindSessionOptions {
  /** The directory the agent was launched in. */
  cwd: string;
  /** Epoch ms of the launch. Sessions older than this belong to someone else. */
  startedAfter: number;
  /** Override the session store (tests). */
  sessionsDir?: string;
  /**
   * Clock slack in ms. Codex stamps the session when it starts, which is a
   * moment or two after we send the launch command.
   */
  slackMs?: number;
}

/**
 * Find the session id of the Codex we launched.
 *
 * Codex has no launch-time session naming — `--profile` does not reach the
 * rollout, and session *names* are auto-generated from the first message — so
 * a session is identified by where it runs and when it started: the newest
 * rollout whose cwd matches ours and which began at or after we launched.
 *
 * Returns null rather than guessing. A wrong id would deliver a room message
 * into somebody else's Codex, which is far worse than falling back to typing.
 */
export function findCodexSessionId(opts: FindSessionOptions): string | null {
  const root = opts.sessionsDir ?? userCodexSessionsDir();
  if (!existsSync(root)) return null;
  const floor = opts.startedAfter - (opts.slackMs ?? 5_000);

  for (const path of rolloutFiles(root)) {
    let firstLine: string;
    try {
      firstLine = readFileSync(path, "utf-8").split("\n", 1)[0] ?? "";
    } catch {
      continue;
    }
    const meta = parseSessionMeta(firstLine);
    if (!meta) continue;
    if (meta.cwd !== opts.cwd) continue;
    if (meta.startedAt < floor) continue;
    return meta.sessionId;
  }
  return null;
}

/** Shell out to `codex queue`. Separated so tests can observe the call. */
export type QueueRunner = (threadId: string, text: string) => void;

const defaultRunner: QueueRunner = (threadId, text) => {
  execFileSync("codex", ["queue", "--thread", threadId, "--message", text], {
    stdio: "ignore",
  });
};

/**
 * Hand a message to a running Codex session. Returns false if Codex refused
 * it, so the caller can fall back to the composer rather than drop the message.
 */
export function queueCodexMessage(
  threadId: string,
  text: string,
  run: QueueRunner = defaultRunner,
): boolean {
  try {
    run(threadId, text);
    return true;
  } catch {
    return false;
  }
}
