/**
 * Read live token usage + cost out of claude's per-session JSONL log.
 *
 * Claude writes one event per line to
 *   ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 * where <cwd-encoded> is the cwd with `/` replaced by `-` (leading `/` becomes
 * a leading `-`). We find the newest jsonl in that directory and aggregate
 * usage across all assistant messages.
 *
 * NOTE — pricing values below are approximate (per million tokens, USD). They
 * are NOT fetched from Anthropic; verify against
 * https://www.anthropic.com/pricing before relying on absolute $ for billing.
 * For relative comparisons across agents/turns in the same session they're
 * fine — the cache-vs-input ratio is what really moves cost.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentMetrics {
  /** Total input tokens (NOT counting cached reads) summed across the session. */
  inputTokens: number;
  /** Total output tokens summed across the session. */
  outputTokens: number;
  /** Total tokens read from prompt cache. */
  cacheReadTokens: number;
  /** Total tokens written to prompt cache. */
  cacheCreateTokens: number;
  /** Approximate USD spent so far this session. */
  costUsd: number;
  /** Approximate input-context size on the last turn (in + cache_read tokens).
   * This is what gets re-sent on the next request before compaction kicks in. */
  lastTurnContextTokens: number;
  /** Last sample's model id (the one used by the latest assistant message). */
  lastModel: string;
}

/**
 * Per-million-token pricing (USD). Edit this table when Anthropic updates
 * pricing or new models ship. Conservative defaults assume Opus pricing for
 * unknown ids so we over-estimate cost rather than under.
 */
interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const PRICES_USD_PER_M: Record<string, ModelPrices> = {
  // Opus family — premium tier
  opus:    { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  // Sonnet family — balanced tier (~5x cheaper than Opus)
  sonnet:  { input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  // Haiku family — fast/cheap tier (~20x cheaper than Opus)
  haiku:   { input:  0.80, output:  4.00, cacheRead: 0.08, cacheWrite:  1.00 },
};
// 1m-context variants charge ~2x for input + cache. Output unchanged.
const ONE_M_MULTIPLIER = 2;

function priceFor(modelId: string): ModelPrices {
  const lower = modelId.toLowerCase();
  let base: ModelPrices = PRICES_USD_PER_M.opus; // safe default
  if (lower.includes("haiku")) base = PRICES_USD_PER_M.haiku;
  else if (lower.includes("sonnet")) base = PRICES_USD_PER_M.sonnet;
  else if (lower.includes("opus")) base = PRICES_USD_PER_M.opus;
  if (lower.includes("[1m]") || lower.includes("-1m")) {
    return {
      input: base.input * ONE_M_MULTIPLIER,
      output: base.output,
      cacheRead: base.cacheRead * ONE_M_MULTIPLIER,
      cacheWrite: base.cacheWrite * ONE_M_MULTIPLIER,
    };
  }
  return base;
}

/**
 * Convert an absolute cwd to claude's encoded project directory name.
 * `/Users/foo/bar` → `-Users-foo-bar`. Realpath first because claude resolves
 * symlinks before encoding (so `/tmp` becomes `-private-tmp` on macOS).
 */
function cwdToProjectDir(cwd: string): string {
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

/**
 * Aggregate session metrics by scanning the newest jsonl for the given cwd.
 * Returns null when no jsonl exists yet (agent hasn't taken a turn).
 *
 * Best-effort: malformed lines are skipped. This is called periodically (e.g.
 * every 10s) so it must be cheap — the parse is O(session_lines) but the
 * file is small (~hundreds of KB) for active sessions.
 */
export function readAgentMetrics(cwd: string): AgentMetrics | null {
  const path = findLatestJsonl(cwd);
  if (!path) return null;
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch { return null; }

  let totals = {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreateTokens: 0,
    costUsd: 0,
  };
  let lastTurnContextTokens = 0;
  let lastModel = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: { message?: { usage?: Record<string, number>; model?: string } };
    try { event = JSON.parse(line); }
    catch { continue; }
    const msg = event.message;
    if (!msg || typeof msg !== "object") continue;
    const usage = msg.usage;
    if (!usage) continue;
    const model = typeof msg.model === "string" ? msg.model : lastModel;

    const inp = Number(usage.input_tokens) || 0;
    const out = Number(usage.output_tokens) || 0;
    const cr  = Number(usage.cache_read_input_tokens) || 0;
    const cw  = Number(usage.cache_creation_input_tokens) || 0;

    totals.inputTokens += inp;
    totals.outputTokens += out;
    totals.cacheReadTokens += cr;
    totals.cacheCreateTokens += cw;

    if (model) {
      const p = priceFor(model);
      totals.costUsd +=
        (inp * p.input + out * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
      lastModel = model;
    }

    lastTurnContextTokens = inp + cr + cw;
  }

  return { ...totals, lastTurnContextTokens, lastModel };
}
