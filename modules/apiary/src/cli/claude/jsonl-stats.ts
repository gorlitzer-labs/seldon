/**
 * Read live token usage out of claude's per-session JSONL log.
 *
 * Claude writes one event per line to
 *   ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 * where <cwd-encoded> is the cwd with `/` replaced by `-` (leading `/` becomes
 * a leading `-`). We find the newest jsonl in that directory and aggregate
 * usage across all assistant messages.
 *
 * Incremental tailing: the first call parses the whole file; subsequent
 * calls only parse bytes appended since the last call. Active sessions
 * accumulate ~300KB over an hour — re-reading every 10s is wasteful and
 * scales badly with N agents. Cache is keyed by path so rotation (a new
 * session starts → newest jsonl changes) resets cleanly.
 */

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Convert an absolute cwd to claude's encoded project directory name.
 * `/Users/foo/bar` → `-Users-foo-bar`.
 * Exported for testing.
 */
export function cwdToProjectDir(cwd: string): string {
  // Claude Code slugifies the cwd by replacing BOTH separators and dots with
  // dashes, so /Users/ada.lovelace/x becomes -Users-ada-lovelace-x. Replacing
  // only "/" silently produced a path that never exists for any user whose
  // home directory contains a dot — and the caller treats "no file" as "no
  // metrics yet", so the room's context meter simply never appeared. It had
  // reported zero metrics events in its entire life before this was found,
  // which is how an agent reached 262k tokens with nothing on screen to say so.
  return cwd.replace(/[/.]/g, "-");
}

function findLatestJsonl(cwd: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects", cwdToProjectDir(cwd));
  if (!existsSync(projectsDir)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const f of readdirSync(projectsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(projectsDir, f);
    try {
      const st = statSync(p);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs };
    } catch { /* skip */ }
  }
  return newest?.path ?? null;
}

// ── Incremental tail state ───────────────────────────────────────────────────

interface TailState {
  path: string;
  offset: number;
  /** Running totals across all bytes consumed so far. */
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  /** Last-seen values (for per-turn fields like context size). */
  lastTurnContextTokens: number;
  lastModel: string;
  /** Tail buffer for an incomplete trailing line. */
  carry: string;
}

// One state per cwd. Module-scope so successive readAgentMetrics calls reuse it.
const tailStates = new Map<string, TailState>();

function freshState(path: string): TailState {
  return {
    path,
    offset: 0,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    lastTurnContextTokens: 0,
    lastModel: "",
    carry: "",
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Approximate input-context size on the last turn (in + cache_read + cache_create). */
  lastTurnContextTokens: number;
  /** Last sample's model id (the one used by the latest assistant message). */
  lastModel: string;
}

/**
 * Aggregate session metrics, reading only bytes added since the last call.
 * Returns null when no jsonl exists yet (agent hasn't taken a turn).
 *
 * Handles rotation (newest jsonl path changes → fresh state) and truncation
 * (current file shorter than our remembered offset → fresh state).
 */
export function readAgentMetrics(cwd: string): AgentMetrics | null {
  const path = findLatestJsonl(cwd);
  if (!path) return null;

  let state = tailStates.get(cwd);
  // Rotation: a new session started, replacing the latest jsonl.
  if (state && state.path !== path) state = undefined;
  if (!state) {
    state = freshState(path);
    tailStates.set(cwd, state);
  }

  let size: number;
  try { size = statSync(path).size; }
  catch { return null; }

  // Truncation (rare for claude but defensive): file shrunk → reset.
  if (size < state.offset) {
    state = freshState(path);
    tailStates.set(cwd, state);
  }
  if (size === state.offset && state.lastModel === "") return null;
  if (size === state.offset) return snapshot(state);

  // Read the new chunk
  const chunkLen = size - state.offset;
  const buf = Buffer.alloc(chunkLen);
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch { return snapshot(state); }
  try {
    readSync(fd, buf, 0, chunkLen, state.offset);
  } finally {
    closeSync(fd);
  }
  state.offset = size;

  const text = state.carry + buf.toString("utf-8");
  const newlineEnd = text.lastIndexOf("\n");
  const completeLines = newlineEnd >= 0 ? text.slice(0, newlineEnd) : "";
  state.carry = newlineEnd >= 0 ? text.slice(newlineEnd + 1) : text;

  for (const line of completeLines.split("\n")) {
    consumeLine(state, line);
  }

  return snapshot(state);
}

function snapshot(s: TailState): AgentMetrics {
  return {
    ...s.totals,
    lastTurnContextTokens: s.lastTurnContextTokens,
    lastModel: s.lastModel,
  };
}

/**
 * Apply one jsonl line to the rolling totals. Tolerant of malformed lines
 * and missing usage fields. Exported for testing.
 */
export function consumeLine(state: {
  totals: TailState["totals"];
  lastTurnContextTokens: number;
  lastModel: string;
}, line: string): void {
  if (!line.trim()) return;
  let event: { message?: { usage?: Record<string, number>; model?: string } };
  try { event = JSON.parse(line); }
  catch { return; }
  const msg = event.message;
  if (!msg || typeof msg !== "object") return;
  const usage = msg.usage;
  if (!usage) return;

  const inp = Number(usage.input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  const cr  = Number(usage.cache_read_input_tokens) || 0;
  const cw  = Number(usage.cache_creation_input_tokens) || 0;

  state.totals.inputTokens += inp;
  state.totals.outputTokens += out;
  state.totals.cacheReadTokens += cr;
  state.totals.cacheCreateTokens += cw;

  if (typeof msg.model === "string") state.lastModel = msg.model;

  state.lastTurnContextTokens = inp + cr + cw;
}

/** Reset all in-memory tail state. For tests. */
export function _resetForTest(): void {
  tailStates.clear();
}
