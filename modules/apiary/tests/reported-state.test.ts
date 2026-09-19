/**
 * Tests for detectReportedStateFromLines — the state a HUMAN is shown.
 *
 * Separate from tmux-bridge.test.ts, which covers detectStateFromLines: the
 * delivery gate. The two have opposite cost asymmetries and these tests exist
 * to keep them from being collapsed back into one.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  detectReportedStateFromLines,
  detectStateFromLines,
} from "../src/cli/claude/tmux-bridge.js";

function lines(s: string): string[] {
  const arr = s.split("\n");
  if (arr[0]?.trim() === "") arr.shift();
  return arr;
}

/**
 * Verbatim tail of `tmux capture-pane -t apiary_fableboy` at the moment the
 * room strip claimed "⏸ needs you". The agent was 23 minutes into a turn with
 * a harness run 5m53s into a 10m timeout. It needed nothing.
 *
 * The trigger is "the approved top" in its own tool output, matched by the
 * bare substring "approve" in PERMISSION_PATTERNS.
 */
const WORKING_BUT_SAID_APPROVED = lines(`
⏺ Bash(cd "$SCRATCH/wt-land2"…)
  ⎿  3x warm launched; meanwhile the geometry ceiling, computed rather than eyeballed:
     flats      429m  0.779 m/px
        beacon height budget above terrain: 6.65m = 8.5px  <- hard cap, set by the approved top
     … +12 lines (ctrl+o to expand)
  ⎿  Running… (5m 53s · timeout 10m)
     (ctrl+b ctrl+b (twice) to run in background)
✻ Fluttering… (23m 23s · ↓ 25.0k tokens)
────────────────────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 1 agent
`);

/** A real permission prompt, which must still stop the operator. */
const REAL_PERMISSION = lines(`
⏺ Bash(rm -rf build)
  Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No, and tell Claude what to do differently
`);

/** The folder-trust modal, which no flag skips. */
const REAL_TRUST = lines(`
  Do you trust the files in this folder?
❯ 1. Yes, I trust this folder
  2. No, exit
`);

describe("detectReportedStateFromLines", () => {
  test("an agent that merely SAID 'approved' is not reported as needing you", () => {
    // The bug, exactly as observed. The delivery gate may still be cautious;
    // the human-facing answer must not be "needs you".
    const reported = detectReportedStateFromLines(WORKING_BUT_SAID_APPROVED);
    expect(reported).not.toBe("permission");
    expect(reported).not.toBe("dialog");
    expect(reported).toBe("streaming");
  });

  test("the delivery gate stays deliberately cautious on that same screen", () => {
    // Proves the two reads are genuinely different rather than one renamed.
    // Over-matching is correct here: it only queues the event for a retry.
    expect(detectStateFromLines(WORKING_BUT_SAID_APPROVED)).toBe("permission");
  });

  test("prose about navigating is not a selection dialog", () => {
    // "to navigate" is DIALOG_PATTERNS chrome and also an ordinary English
    // phrase — fatal in a project about navigating by bearings.
    const prose = lines(`
⏺ The player has to navigate by bearings, so flats must be legible.
✻ Cogitating… (12s)
`);
    expect(detectReportedStateFromLines(prose)).not.toBe("dialog");
  });

  test("real dialog chrome, with the arrow glyphs, still reports as a dialog", () => {
    const dialog = lines(`
  Which approach?
❯ 1. Landmark
  2. Card copy
  ↑↓ to navigate · Enter to select
`);
    expect(detectReportedStateFromLines(dialog)).toBe("dialog");
  });

  test("a real permission prompt still reaches the operator", () => {
    expect(detectReportedStateFromLines(REAL_PERMISSION)).toBe("permission");
  });

  test("the folder-trust modal still reaches the operator", () => {
    expect(detectReportedStateFromLines(REAL_TRUST)).toBe("permission");
  });

  test("an idle composer is reported idle, not blocked", () => {
    expect(detectReportedStateFromLines(lines(`
⏺ Done.
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`))).toBe("idle");
  });

  // ── The wiring, not just the logic ──────────────────────────────────────
  //
  // Without this, reverting run.ts to report via detectState() leaves the bug
  // fully live and every other test in this file still green. That mutant was
  // run and it survived, which is the only reason this test exists.
  test("the activity heartbeat reports via detectReportedState, not detectState", () => {
    const src = readFileSync("src/cli/claude/run.ts", "utf-8");
    // The heartbeat is the only place a state is computed for broadcast.
    const call = src.match(/state = claudeStateToActivity\(\s*bridge\.(\w+)\(\)\s*\)/);
    expect(call, "the activity heartbeat's state assignment moved or was renamed").not.toBeNull();
    expect(call![1]).toBe("detectReportedState");
  });
});
