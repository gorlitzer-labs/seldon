/**
 * Read live token usage + cost out of claude's per-session JSONL log.
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
 *
 * NOTE — pricing values come from src/cli/claude/pricing.json. Verify
 * against https://www.anthropic.com/pricing for billing-grade numbers.
 * For relative comparisons across agents/turns in the same session they're
 * fine — the cache-vs-input ratio is what really moves cost.
 */

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import bundledPricing from "./pricing.json" with { type: "json" };

// ── Pricing table ────────────────────────────────────────────────────────────

export interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PricingFile {
  opus: ModelPrices;
  sonnet: ModelPrices;
  haiku: ModelPrices;
  _oneMMultiplier?: number;
}

const DEFAULT_PRICING: PricingFile = {
  opus:   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  sonnet: { input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  haiku:  { input:  0.80, output:  4.00, cacheRead: 0.08, cacheWrite:  1.00 },
  _oneMMultiplier: 2,
};

/**
 * Pricing is inlined at build time from src/cli/claude/pricing.json (esbuild
 * handles JSON imports natively). At runtime we ALSO check for a user override
 * at ~/.apiary/pricing.json — if present, it shallow-merges over the bundled
 * defaults so admins can update prices without rebuilding apiary.
 */
let pricingCache: PricingFile | null = null;
function loadPricing(): PricingFile {
  if (pricingCache) return pricingCache;
  let merged: PricingFile = { ...DEFAULT_PRICING, ...(bundledPricing as Partial<PricingFile>) };
  try {
    const override = join(homedir(), ".apiary", "pricing.json");
    if (existsSync(override)) {
      const data = JSON.parse(readFileSync(override, "utf-8"));
      merged = { ...merged, ...data };
    }
  } catch { /* user override is best-effort */ }
  pricingCache = merged;
  return pricingCache;
}

/**
 * Resolve a model id to its price block. Family inferred from substring
 * (haiku → cheapest, sonnet → mid, opus → priciest; default opus to
 * over-estimate rather than under). `[1m]` / `-1m` variants multiply
 * input + cache (output unchanged) by the configured factor.
 *
 * Exported for testing.
 */
export function priceFor(modelId: string): ModelPrices {
  const prices = loadPricing();
  const lower = modelId.toLowerCase();
  let base: ModelPrices = prices.opus;
  if (lower.includes("haiku")) base = prices.haiku;
  else if (lower.includes("sonnet")) base = prices.sonnet;
  else if (lower.includes("opus")) base = prices.opus;
  if (lower.includes("[1m]") || lower.includes("-1m")) {
    const m = prices._oneMMultiplier ?? 2;
    return {
      input: base.input * m,
      output: base.output,
      cacheRead: base.cacheRead * m,
      cacheWrite: base.cacheWrite * m,
    };
  }
  return base;
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Convert an absolute cwd to claude's encoded project directory name.
 * `/Users/foo/bar` → `-Users-foo-bar`.
 * Exported for testing.
 */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
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
    costUsd: number;
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
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 },
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
  costUsd: number;
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

  const model = typeof msg.model === "string" ? msg.model : state.lastModel;
  if (model) {
    const p = priceFor(model);
    state.totals.costUsd +=
      (inp * p.input + out * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
    state.lastModel = model;
  }

  state.lastTurnContextTokens = inp + cr + cw;
}

/** Reset all in-memory tail state. For tests. */
export function _resetForTest(): void {
  tailStates.clear();
  pricingCache = null;
}
