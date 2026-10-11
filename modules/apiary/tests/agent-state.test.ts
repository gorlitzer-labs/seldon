/**
 * Tests for bridge-state → room-state mapping.
 *
 * The invariant: a screen that only a human can clear must map to "blocked",
 * never "working". Both look like a spinner from the room's side, but only one
 * of them ever resolves by waiting — and conflating them is how an agent sits
 * stuck while the room reports progress.
 */

import { describe, test, expect } from "vitest";

import { codexStateToActivity, claudeStateToActivity } from "../src/cli/agent-state.js";
import { shouldApplyAgentState, OBSERVED_TTL_MS } from "../src/cli/tui.js";
import { detectCodexStateFromLines, extractCodexActivityLabel } from "../src/cli/codex/tmux-bridge.js";

function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

describe("codexStateToActivity", () => {
  test("a screen needing a human is blocked, not working", () => {
    expect(codexStateToActivity("approval")).toBe("blocked");
    expect(codexStateToActivity("blocked")).toBe("blocked");
  });

  test("streaming is working", () => {
    expect(codexStateToActivity("streaming")).toBe("working");
  });

  test("a usable composer is idle", () => {
    expect(codexStateToActivity("idle")).toBe("idle");
    expect(codexStateToActivity("typing")).toBe("idle");
  });

  test("unknown reports nothing rather than guessing", () => {
    // Reporting a guess as observed truth would outrank the room's own
    // inference for the observed TTL — worse than staying quiet.
    expect(codexStateToActivity("unknown")).toBeUndefined();
  });
});

describe("claudeStateToActivity", () => {
  test("permission and dialog prompts are blocked", () => {
    expect(claudeStateToActivity("permission")).toBe("blocked");
    expect(claudeStateToActivity("dialog")).toBe("blocked");
  });

  test("streaming is working, composer states are idle", () => {
    expect(claudeStateToActivity("streaming")).toBe("working");
    expect(claudeStateToActivity("idle")).toBe("idle");
    expect(claudeStateToActivity("typing")).toBe("idle");
  });

  test("unknown reports nothing", () => {
    expect(claudeStateToActivity("unknown")).toBeUndefined();
  });
});

describe("end to end: the screen that started this", () => {
  test("a real Codex command-approval pane reports 'blocked'", () => {
    // Verbatim from the live agent that the room was showing as "…" (working)
    // while it sat waiting for a keypress.
    const lines = screen(`
  Codex wants to run a command

    node scripts/smoke.mjs

  › 1. Yes, proceed (y)
    2. Yes, and don't ask again for commands that start with \`node scripts/
       smoke.mjs\` (p)
    3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`);
    const state = detectCodexStateFromLines(lines);
    expect(state).toBe("approval");
    expect(codexStateToActivity(state)).toBe("blocked");
  });

  test("a Codex sign-in screen also reports 'blocked'", () => {
    const lines = screen(`
  Welcome to Codex, OpenAI's command-line coding agent

  Finish signing in via your browser
`);
    expect(codexStateToActivity(detectCodexStateFromLines(lines))).toBe("blocked");
  });

  test("a working Codex pane reports 'working'", () => {
    const lines = screen(`
  • I'll check the smoke script now.

  • Working (8s • esc to interrupt)
`);
    expect(codexStateToActivity(detectCodexStateFromLines(lines))).toBe("working");
  });
});

describe("extractCodexActivityLabel", () => {
  test("pulls the status text and drops the interrupt hint", () => {
    const lines = screen(`
  • Reading files

  • Working (8s • esc to interrupt)
`);
    expect(extractCodexActivityLabel(lines)).toBe("Working (8s");
  });

  test("null when nothing is running", () => {
    const lines = screen(`
  • Done.

  › Ask Codex to do anything
`);
    expect(extractCodexActivityLabel(lines)).toBeNull();
  });

  test("prefers the status line over conversation text quoting the same word", () => {
    const lines = screen(`
  I am working on the parser, as you asked.

  • Compacting conversation
`);
    expect(extractCodexActivityLabel(lines)).toBe("Compacting conversation");
  });

  test("is bounded in length", () => {
    const lines = ["• Working " + "x".repeat(500)];
    expect(extractCodexActivityLabel(lines)!.length).toBeLessThanOrEqual(120);
  });

  test("empty screen is null, not a crash", () => {
    expect(extractCodexActivityLabel([])).toBeNull();
  });
});

describe("observed beats inferred", () => {
  // The room marks EVERY agent "working" on every human message. Without
  // precedence, one chat line buries a reported "needs you" — the single
  // state the user has to act on — and the agent silently waits forever.

  test("an observed update always applies", () => {
    expect(shouldApplyAgentState({ observed: true, lastObservedAt: Date.now(), now: Date.now() }))
      .toBe(true);
  });

  test("an inferred update is dropped while an observed state is fresh", () => {
    const now = 1_000_000;
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: now - 1_000, now }))
      .toBe(false);
  });

  test("an inferred update applies once the observed state goes stale", () => {
    // A dead runtime stops heartbeating; inference must take over rather than
    // pinning the last thing it ever said.
    const now = 1_000_000;
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: now - OBSERVED_TTL_MS - 1, now }))
      .toBe(true);
  });

  test("an inferred update applies when nothing was ever observed", () => {
    // Agents whose runtime predates state reporting must still show something.
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: undefined, now: Date.now() }))
      .toBe(true);
  });

  test("the TTL comfortably outlasts the ~1.5s heartbeat", () => {
    expect(OBSERVED_TTL_MS).toBeGreaterThan(1500 * 3);
  });

  test("exactly at the TTL boundary, inference wins", () => {
    const now = 1_000_000;
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: now - OBSERVED_TTL_MS, now }))
      .toBe(true);
  });
});
