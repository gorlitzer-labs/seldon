/**
 * Wait for another agent to reach a state.
 *
 * Without this, an agent that needs to act after another one finishes has two
 * options, both bad: re-read the room on a loop (a full LLM turn per check,
 * which is the expensive thing), or guess and collide.
 *
 * It became buildable once runtimes started reporting the state they read off
 * their own CLI's screen, because "working" and "blocked" look identical from
 * the room's side and only one of them ever resolves on its own.
 *
 * Deliberately bounded rather than open-ended: the call has to return inside
 * the MCP client's tool timeout, so it reports the state it last saw and lets
 * the caller decide whether to wait again. A tool that hangs past the client's
 * timeout fails the turn, which is worse than one that says "still working".
 */

/** The states a runtime reports. `unknown` means it reports nothing. */
export type AgentWaitState = "idle" | "working" | "blocked" | "unknown";

/** What the caller is waiting for. */
export type WaitTarget = "idle" | "blocked" | "working" | "change";

export interface WaitForAgentOptions {
  /** Read the target's current state. `unknown` if it isn't reporting. */
  readState: () => Promise<AgentWaitState>;
  /** What to wait for. Default "idle" — "they finished, my turn". */
  until?: WaitTarget;
  /** Give up after this long. Default 60s, capped by `maxWaitMs`. */
  timeoutMs?: number;
  /** Hard ceiling, to stay inside the MCP client's tool timeout. */
  maxWaitMs?: number;
  /** Gap between reads. Default 2s — this is cheap, unlike an LLM turn. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type WaitOutcome =
  | { result: "satisfied"; state: AgentWaitState; waitedMs: number }
  | { result: "timeout"; state: AgentWaitState; waitedMs: number }
  /** The target reports no state at all — waiting would never end. */
  | { result: "not-reporting"; state: "unknown"; waitedMs: number };

export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;

/**
 * Clamp a requested wait to something that returns inside the MCP client's
 * tool timeout. Exported so the clamp is testable without actually waiting.
 */
export function resolveBudgetMs(timeoutMs: number | undefined, maxWaitMs: number = MAX_WAIT_MS): number {
  return Math.min(Math.max(timeoutMs ?? DEFAULT_WAIT_MS, 0), maxWaitMs);
}

/** Is `state` what the caller asked for? */
export function satisfies(state: AgentWaitState, until: WaitTarget, initial: AgentWaitState): boolean {
  if (state === "unknown") return false;
  if (until === "change") return state !== initial;
  return state === until;
}

/**
 * Poll until the target agent reaches `until`, or the deadline passes.
 *
 * Returns `not-reporting` immediately if the agent reports no state, rather
 * than burning the whole timeout on something that cannot change: a runtime
 * with no heartbeat (or one that has died) would otherwise look exactly like
 * an agent that is simply taking a long time.
 */
export async function waitForAgent(opts: WaitForAgentOptions): Promise<WaitOutcome> {
  const {
    readState,
    until = "idle",
    maxWaitMs = MAX_WAIT_MS,
    pollIntervalMs = DEFAULT_POLL_MS,
    sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }),
    now = () => Date.now(),
  } = opts;

  const budget = resolveBudgetMs(opts.timeoutMs, maxWaitMs);
  const started = now();

  const initial = await readState();
  if (initial === "unknown") {
    return { result: "not-reporting", state: "unknown", waitedMs: now() - started };
  }
  if (satisfies(initial, until, initial)) {
    return { result: "satisfied", state: initial, waitedMs: now() - started };
  }

  let latest: AgentWaitState = initial;
  // Counted rather than wall-clocked so an injected instant sleep cannot spin.
  const steps = Math.max(1, Math.ceil(budget / pollIntervalMs));
  for (let step = 0; step < steps; step++) {
    await sleep(pollIntervalMs);
    latest = await readState();
    if (satisfies(latest, until, initial)) {
      return { result: "satisfied", state: latest, waitedMs: now() - started };
    }
  }

  return { result: "timeout", state: latest, waitedMs: now() - started };
}

/** One line for the agent, saying what happened and what to do next. */
export function describeOutcome(
  participant: string,
  until: WaitTarget,
  outcome: WaitOutcome,
): string {
  const secs = Math.round(outcome.waitedMs / 1000);
  switch (outcome.result) {
    case "satisfied":
      return `${participant} is now ${outcome.state} (waited ${secs}s).`;
    case "timeout":
      return `${participant} is still ${outcome.state} after ${secs}s — not ${until} yet. `
        + `Call again to keep waiting, or get on with something else.`;
    case "not-reporting":
      return `${participant} does not report its state, so there is nothing to wait for. `
        + `Only agents started by apiary with a Claude Code or Codex runtime report it. `
        + `Ask them directly instead.`;
  }
}
