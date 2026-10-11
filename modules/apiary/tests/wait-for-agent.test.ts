/**
 * Tests for waiting on another agent's state.
 *
 * The point of the tool is to replace "re-read the room every few seconds to
 * see if they're done", which costs a full LLM turn per check. So the two
 * things that must hold: it returns promptly when the state arrives, and it
 * never waits on something that cannot change.
 */

import { describe, test, expect, vi } from "vitest";

import {
  waitForAgent,
  satisfies,
  describeOutcome,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  resolveBudgetMs,
  type AgentWaitState,
} from "../src/agent/wait-for-agent.js";
import { shouldReportActivity, ACTIVITY_REPORT_MIN_MS } from "../src/agent/event-processor.js";

const noSleep = async () => {};

/** A readState that walks a scripted sequence, repeating the last value. */
function scripted(states: AgentWaitState[]) {
  let i = 0;
  return vi.fn(async () => states[Math.min(i++, states.length - 1)]);
}

describe("satisfies", () => {
  test("matches the requested state", () => {
    expect(satisfies("idle", "idle", "working")).toBe(true);
    expect(satisfies("blocked", "blocked", "working")).toBe(true);
    expect(satisfies("working", "idle", "working")).toBe(false);
  });

  test("'change' means anything other than where it started", () => {
    expect(satisfies("blocked", "change", "working")).toBe(true);
    expect(satisfies("working", "change", "working")).toBe(false);
  });

  test("unknown never satisfies anything", () => {
    // Including "change" — a runtime going silent is not a state change.
    expect(satisfies("unknown", "idle", "working")).toBe(false);
    expect(satisfies("unknown", "change", "working")).toBe(false);
  });
});

describe("waitForAgent", () => {
  test("returns immediately when already in the wanted state", () => {
    return waitForAgent({ readState: scripted(["idle"]), until: "idle", sleep: noSleep })
      .then((o) => expect(o).toMatchObject({ result: "satisfied", state: "idle" }));
  });

  test("waits, then reports the transition", async () => {
    const readState = scripted(["working", "working", "idle"]);
    const outcome = await waitForAgent({ readState, until: "idle", pollIntervalMs: 1, sleep: noSleep });

    expect(outcome).toMatchObject({ result: "satisfied", state: "idle" });
    // Stopped as soon as it saw it, rather than polling out the budget.
    expect(readState).toHaveBeenCalledTimes(3);
  });

  test("catches an agent becoming blocked", async () => {
    // The case worth waiting for: they need a human, so stop expecting output.
    const outcome = await waitForAgent({
      readState: scripted(["working", "blocked"]),
      until: "blocked",
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ result: "satisfied", state: "blocked" });
  });

  test("times out reporting the state it last saw", async () => {
    const outcome = await waitForAgent({
      readState: scripted(["working"]),
      until: "idle",
      timeoutMs: 10,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ result: "timeout", state: "working" });
  });

  test("an agent that reports nothing returns at once, not after the timeout", async () => {
    // Otherwise a runtime with no heartbeat (or a dead one) looks exactly like
    // an agent taking a long time, and the caller burns the whole budget.
    const readState = scripted(["unknown"]);
    const outcome = await waitForAgent({ readState, until: "idle", sleep: noSleep });

    expect(outcome).toMatchObject({ result: "not-reporting" });
    expect(readState).toHaveBeenCalledTimes(1);
  });

  test("a transient read failure mid-wait does not end the wait", async () => {
    // readState returns "unknown" on a network blip; that must not be treated
    // as the agent having stopped reporting.
    const outcome = await waitForAgent({
      readState: scripted(["working", "unknown", "idle"]),
      until: "idle",
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ result: "satisfied", state: "idle" });
  });

  test("the wait is capped, so it cannot outlive the client's tool timeout", async () => {
    // The budget, not the poll count, is what bounds this — see
    // resolveBudgetMs below for the clamp itself. Kept small here so a broken
    // clamp fails the assertion rather than spinning for a billion iterations,
    // which reads as a hung suite instead of a failing test.
    const readState = scripted(["working"]);
    await waitForAgent({
      readState,
      until: "idle",
      timeoutMs: 50,
      maxWaitMs: 10,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    // 10ms cap / 1ms poll = 10 polls + the initial read.
    expect(readState.mock.calls.length).toBeLessThanOrEqual(11);
  });

  test("a negative or zero timeout still checks once", async () => {
    const outcome = await waitForAgent({
      readState: scripted(["idle"]),
      until: "idle",
      timeoutMs: -5,
      sleep: noSleep,
    });
    expect(outcome.result).toBe("satisfied");
  });

  test("the cap is smaller than a typical MCP tool timeout", () => {
    expect(MAX_WAIT_MS).toBeLessThanOrEqual(180_000);
    expect(DEFAULT_WAIT_MS).toBeLessThanOrEqual(MAX_WAIT_MS);
  });
});

describe("describeOutcome", () => {
  test("says what happened", () => {
    expect(describeOutcome("bee", "idle", { result: "satisfied", state: "idle", waitedMs: 4200 }))
      .toContain("bee is now idle");
  });

  test("a timeout tells the agent what to do next", () => {
    const msg = describeOutcome("bee", "idle", { result: "timeout", state: "working", waitedMs: 60_000 });
    expect(msg).toContain("still working");
    expect(msg).toMatch(/call again/i);
  });

  test("not-reporting explains why waiting is pointless", () => {
    // Otherwise the agent retries forever against something that cannot answer.
    const msg = describeOutcome("bee", "idle", { result: "not-reporting", state: "unknown", waitedMs: 0 });
    expect(msg).toMatch(/does not report/i);
    expect(msg).toMatch(/ask them directly/i);
  });
});

describe("resolveBudgetMs", () => {
  // Tested directly rather than through waitForAgent: with the clamp removed,
  // a huge timeout and a 1ms poll is a billion iterations, so the mutant used
  // to be "caught" by hanging the suite — which is indistinguishable from a
  // broken test.
  test("caps an absurd request", () => {
    expect(resolveBudgetMs(999_999_999)).toBe(MAX_WAIT_MS);
  });

  test("passes a reasonable request through", () => {
    expect(resolveBudgetMs(30_000)).toBe(30_000);
  });

  test("defaults when unset", () => {
    expect(resolveBudgetMs(undefined)).toBe(DEFAULT_WAIT_MS);
  });

  test("never negative", () => {
    expect(resolveBudgetMs(-1)).toBe(0);
  });

  test("honours a lower explicit cap", () => {
    expect(resolveBudgetMs(60_000, 5_000)).toBe(5_000);
  });
});

describe("shouldReportActivity", () => {
  // The bug this pins, found end-to-end: reporting only on change meant a
  // settled agent stopped reporting, aged out of the room's state store, and
  // read as "reports no state at all" ~15s after going idle.
  const base = {
    label: "Working (8s",
    state: "working" as const,
    lastLabel: "Working (8s",
    lastState: "working" as const,
    lastReportAt: 1_000_000,
    now: 1_000_000,
    minIntervalMs: 10_000,
  };

  test("reports when the state changes", () => {
    expect(shouldReportActivity({ ...base, state: "idle" })).toBe(true);
  });

  test("reports when the label changes", () => {
    expect(shouldReportActivity({ ...base, label: "Working (9s" })).toBe(true);
  });

  test("reports when a label appears or clears", () => {
    expect(shouldReportActivity({ ...base, label: null })).toBe(true);
    expect(shouldReportActivity({ ...base, lastLabel: null })).toBe(true);
  });

  test("stays quiet when nothing changed and the last report is fresh", () => {
    expect(shouldReportActivity({ ...base, now: base.lastReportAt + 5_000 })).toBe(false);
  });

  test("RE-REPORTS an unchanged state once the last report goes stale", () => {
    // Without this a settled agent silently disappears from the state store.
    expect(shouldReportActivity({ ...base, now: base.lastReportAt + 10_001 })).toBe(true);
  });

  test("re-reports an unchanged idle+no-label agent too", () => {
    // The exact shape of a finished agent: state idle, label null, forever.
    expect(shouldReportActivity({
      ...base,
      label: null, lastLabel: null,
      state: "idle", lastState: "idle",
      now: base.lastReportAt + 10_001,
    })).toBe(true);
  });

  test("the re-report interval is well inside the room's state TTL", () => {
    // The server ages state out after 15s; reporting less often than that
    // would let a live agent lapse.
    expect(ACTIVITY_REPORT_MIN_MS).toBeLessThan(15_000);
  });
});
