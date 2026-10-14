/**
 * Tests for telling an idle Claude Code pane from a busy one.
 *
 * "← 1 agent" in the footer used to be read as "a subagent is running". On
 * Claude Code v2.1.299 every idle session shows it (four live panes checked on
 * 2026-10-14) and it disappears while a background agent runs, so reading it as
 * busy made every idle pane look busy forever: events only got through via the
 * 30s force-inject. The live status line is the busy signal now — its glyphs
 * are no longer the braille spinner, but its shape is stable.
 */

import { describe, test, expect } from "vitest";

import { detectStateFromLines, composerHoldsOnlyGhost } from "../src/cli/claude/tmux-bridge.js";
import { claudeStateToActivity } from "../src/cli/agent-state.js";

function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

const RULE = "─".repeat(60);

/** Verbatim shape of an idle v2.1.299 pane (scratch session, 2026-10-14). */
const IDLE_PANE = screen(`
⏺ I joined the apiary room as "Reader" and set the mode to standby-everyone.
✻ Worked for 7s · done 11:27 AM
${RULE}
❯
${RULE}
  PERSONAL · franco (Max) · Haiku 5.5
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
`);

/** Mid-turn: the live status line, with a non-braille glyph. */
const WORKING_PANE = screen(`
❯ Join the apiary room and wait.
✢ Perusing… (2s · ↓ 88 tokens · thinking)
${RULE}
❯
${RULE}
  PERSONAL · franco (Max) · Haiku 5.5
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
`);

describe("idle is idle", () => {
  test("an idle pane with '← 1 agent' in the footer is idle", () => {
    expect(detectStateFromLines(IDLE_PANE)).toBe("idle");
    expect(claudeStateToActivity(detectStateFromLines(IDLE_PANE))).not.toBe("working");
  });

  test("plural and multiple agents in the footer are not busy either", () => {
    for (const footer of ["← 1 agent", "← 2 agents", "←  12  agents"]) {
      const lines = screen(`
${RULE}
❯
${RULE}
  ⏵⏵ bypass permissions on · ${footer}
`);
      expect(detectStateFromLines(lines), footer).toBe("idle");
    }
  });

  test("the finished status line is not busy", () => {
    const lines = screen(`
✻ Brewed for 1s · done 11:33 AM
${RULE}
❯
${RULE}
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });
});

describe("busy is busy", () => {
  test("the live status line marks a turn in progress", () => {
    expect(detectStateFromLines(WORKING_PANE)).toBe("streaming");
  });

  test("minutes-long turns too", () => {
    const lines = screen(`
✶ Reticulating… (1m 12s · ↑ 3.4k tokens)
${RULE}
❯
${RULE}
`);
    expect(detectStateFromLines(lines)).toBe("streaming");
  });

  test("an ellipsis in conversation text is not busy", () => {
    const lines = screen(`
  Well… (as I said) it is done.
${RULE}
❯
${RULE}
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });
});

describe("a prompt needing a human still outranks busy", () => {
  test("a permission prompt wins over a live turn", () => {
    const lines = screen(`
  Bash command
  npm test
  Do you want to proceed?
  ❯ 1. Yes
✢ Running… (4s · ↓ 10 tokens)
`);
    expect(claudeStateToActivity(detectStateFromLines(lines))).toBe("blocked");
  });

  test("the footer's 'bypass permissions' is not read as a permission prompt", () => {
    const lines = screen(`
${RULE}
❯
${RULE}
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
`);
    expect(detectStateFromLines(lines)).not.toBe("permission");
  });
});

describe("composerHoldsOnlyGhost", () => {
  const PROMPT = "\x1b[39m❯ ";

  test("an empty composer", () => {
    expect(composerHoldsOnlyGhost([RULE, PROMPT, RULE])).toBe(true);
  });

  test("the dim placeholder, verbatim from a fresh session, is not a draft", () => {
    expect(composerHoldsOnlyGhost([RULE, `${PROMPT} \x1b[2mTry "fix typecheck errors"\x1b[0m`, RULE])).toBe(true);
  });

  test("a dim suggestion left unterminated at line end is not a draft", () => {
    expect(composerHoldsOnlyGhost([`${PROMPT} \x1b[2mcheck the room for messages`])).toBe(true);
  });

  test("text the human typed is a draft", () => {
    expect(composerHoldsOnlyGhost([RULE, `${PROMPT} hello draft`, RULE])).toBe(false);
  });

  test("a draft followed by a dim hint is still a draft", () => {
    expect(composerHoldsOnlyGhost([`${PROMPT} deploy it\x1b[2m  (enter to send)\x1b[0m`])).toBe(false);
  });

  test("no prompt on screen is not 'empty'", () => {
    expect(composerHoldsOnlyGhost(["some output", "more output"])).toBe(false);
  });
});
