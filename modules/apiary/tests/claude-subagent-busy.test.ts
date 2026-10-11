/**
 * Tests for detecting Claude Code as busy when it shows no spinner.
 *
 * While a subagent runs, Claude Code's main area goes quiet and the only sign
 * is the footer's "← 1 agent". Spinner-only detection read that as idle, so
 * apiary pasted a room message into a composer that would not submit — checked
 * against a live agent, where even a manual Enter did nothing — and the message
 * sat as a draft until the subagent finished. The room reported the agent idle
 * the whole time.
 */

import { describe, test, expect } from "vitest";

import { detectStateFromLines } from "../src/cli/claude/tmux-bridge.js";
import { claudeStateToActivity } from "../src/cli/agent-state.js";

function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

/** Verbatim from the live agent that surfaced this. */
const SUBAGENT_PANE = screen(`
  ⎿  Tip: Use /clear to start fresh when switching topics and free up context
────────────────────────────────────────────────────────────────────────────
❯ go ahead with the archipelago legibility work
────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
`);

describe("a running subagent counts as busy", () => {
  test("the real pane is busy, not idle", () => {
    // Before: "typing", because there is text at the ❯ prompt and no spinner.
    expect(detectStateFromLines(SUBAGENT_PANE)).toBe("streaming");
  });

  test("and the room says working, not idle", () => {
    // The visible consequence: the strip claimed idle while it was mid-task.
    expect(claudeStateToActivity(detectStateFromLines(SUBAGENT_PANE))).toBe("working");
  });

  test("plural and multiple agents", () => {
    for (const footer of ["← 1 agent", "← 2 agents", "←  12  agents"]) {
      const lines = screen(`
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on · ${footer}
`);
      expect(detectStateFromLines(lines), footer).toBe("streaming");
    }
  });

  test("an empty composer with a subagent out is still busy", () => {
    const lines = screen(`
  • some earlier output
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
`);
    expect(detectStateFromLines(lines)).toBe("streaming");
  });
});

describe("it does not over-trigger", () => {
  test("the same footer WITHOUT a subagent is not busy", () => {
    // The footer is always present; only the "← N agent" part means busy.
    const lines = screen(`
  • done
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).not.toBe("streaming");
  });

  test("the word 'agent' in conversation text is not busy", () => {
    const lines = screen(`
  I asked the other agent to review it, 1 agent is plenty.
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).not.toBe("streaming");
  });

  test("the footer's 'bypass permissions' is not read as a permission prompt", () => {
    // It sits one word away from the permission patterns.
    const lines = screen(`
  • done
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
`);
    expect(detectStateFromLines(lines)).not.toBe("permission");
  });
});

describe("a prompt needing a human still outranks busy", () => {
  test("a permission prompt wins over a running subagent", () => {
    // Both are true; only one of them the user can act on, and reporting
    // "working" would hide it.
    const lines = screen(`
  Bash command
  npm test
  Do you want to proceed?
  ❯ 1. Yes
  ⏵⏵ bypass permissions on · ← 1 agent
`);
    expect(claudeStateToActivity(detectStateFromLines(lines))).toBe("blocked");
  });

  test("a dialog wins too", () => {
    const lines = screen(`
  Choose an option
  Enter to select
  ⏵⏵ bypass permissions on · ← 1 agent
`);
    expect(claudeStateToActivity(detectStateFromLines(lines))).toBe("blocked");
  });
});
