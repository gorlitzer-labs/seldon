/**
 * Tests for capture normalisation.
 *
 * Agent panes are created 200x50 so the CLIs render without wrapping (their
 * output is what the bridges pattern-match, so width is a correctness input).
 * But a pane taller than the CLI's output means `capture-pane` returns a block
 * of trailing blank rows, and both bridges read the bottom of the screen as
 * `lines.slice(-N)`. Untrimmed, that slice lands entirely in the blanks, every
 * state reads "unknown", and the bridge queues events forever rather than
 * delivering them — an agent that looks alive and receives nothing.
 */

import { describe, test, expect } from "vitest";

import { trimTrailingBlankLines, AGENT_PANE_COLS, AGENT_PANE_ROWS } from "../src/cli/tmux.js";
import { detectCodexStateFromLines } from "../src/cli/codex/tmux-bridge.js";
import { detectStateFromLines } from "../src/cli/claude/tmux-bridge.js";

describe("trimTrailingBlankLines", () => {
  test("drops trailing blank rows", () => {
    expect(trimTrailingBlankLines(["a", "b", "", "  ", ""])).toEqual(["a", "b"]);
  });

  test("keeps blank lines that sit between content", () => {
    expect(trimTrailingBlankLines(["a", "", "b", ""])).toEqual(["a", "", "b"]);
  });

  test("an all-blank capture becomes empty, not a false tail", () => {
    expect(trimTrailingBlankLines(["", "  ", ""])).toEqual([]);
  });

  test("already-trimmed input is unchanged", () => {
    expect(trimTrailingBlankLines(["a", "b"])).toEqual(["a", "b"]);
    expect(trimTrailingBlankLines([])).toEqual([]);
  });
});

describe("a tall pane still detects state", () => {
  /** Content at the top, then blank rows out to the full pane height. */
  function tallPane(content: string[]): string[] {
    return [...content, ...Array(AGENT_PANE_ROWS - content.length).fill("")];
  }

  test("codex: idle composer near the top of a 50-row pane", () => {
    const raw = tallPane([
      "╭────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.153.4)     │",
      "╰────────────────────────────────╯",
      "",
      "› Ask Codex to do anything",
    ]);

    // The regression: untrimmed, the tail is all blanks.
    expect(detectCodexStateFromLines(raw)).toBe("unknown");
    expect(detectCodexStateFromLines(trimTrailingBlankLines(raw))).toBe("idle");
  });

  test("codex: an approval dialog near the top is still seen", () => {
    // The dangerous case — missing this reads as idle and the bridge answers
    // a dialog the agent never saw.
    const raw = tallPane([
      "  Codex wants to run a command",
      "    node scripts/smoke.mjs",
      "  Press enter to confirm or esc to cancel",
    ]);

    expect(detectCodexStateFromLines(trimTrailingBlankLines(raw))).toBe("approval");
  });

  test("claude: state survives a tall pane too", () => {
    // Verbatim from a live Claude Code agent pane.
    const content = [
      "✳ Elucidating… (1h 17m 55s · ↓ 162.2k tokens)",
      "  ⎿  Tip: Use /clear to start fresh when switching topics and free up context",
      "────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
    ];

    const trimmed = detectStateFromLines(trimTrailingBlankLines(tallPane(content)));
    // Same verdict whether the pane is exactly as tall as the content or not.
    expect(trimmed).toBe(detectStateFromLines(content));
    expect(trimmed).not.toBe("unknown");
  });
});

describe("agent pane geometry", () => {
  test("wide enough that the CLIs do not wrap mid-pattern", () => {
    // 80 columns wrapped Codex's own hint text, which the bridge matches on.
    expect(AGENT_PANE_COLS).toBeGreaterThanOrEqual(120);
    expect(AGENT_PANE_ROWS).toBeGreaterThanOrEqual(24);
  });
});
