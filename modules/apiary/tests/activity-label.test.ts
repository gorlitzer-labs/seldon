/** Tests for extractActivityLabel — pulls claude's status line from a captured pane. */

import { describe, test, expect } from "vitest";
import { extractActivityLabel } from "../src/cli/claude/tmux-bridge.js";

function lines(s: string): string[] {
  const arr = s.split("\n");
  if (arr[0]?.trim() === "") arr.shift();
  return arr;
}

describe("extractActivityLabel", () => {
  test("returns null for empty input", () => {
    expect(extractActivityLabel([])).toBeNull();
  });

  test("returns null for an idle prompt with no status line", () => {
    expect(extractActivityLabel(lines(`
─────────────────────
❯
─────────────────────
  ⏵⏵ bypass permissions on
`))).toBeNull();
  });

  test("extracts ASCII cooking verbs (Cooked, Baked, Churned)", () => {
    expect(extractActivityLabel(["✻ Cooked for 4s"])).toBe("Cooked for 4s");
    expect(extractActivityLabel(["✻ Baked for 13s"])).toBe("Baked for 13s");
    expect(extractActivityLabel(["✻ Churned for 3s"])).toBe("Churned for 3s");
  });

  test("handles unicode verbs (Sautéed)", () => {
    expect(extractActivityLabel(["✻ Sautéed for 12s"])).toBe("Sautéed for 12s");
  });

  test("extracts Compacting with percentage", () => {
    expect(extractActivityLabel(["✻ Compacting conversation… 23%"]))
      .toBe("Compacting conversation… 23%");
  });

  test("extracts Compacting without percentage but with parenthetical metadata", () => {
    // Real claude output: "✻ Compacting conversation… (2m 9s · ↑ 3.3k tokens)"
    // We strip at the `(` to avoid noisy detail.
    const got = extractActivityLabel(["✻ Compacting conversation… (2m 9s · ↑ 3.3k tokens)"]);
    expect(got).toBe("Compacting conversation…");
  });

  test("extracts standalone Thinking / Loading / Connecting verbs", () => {
    expect(extractActivityLabel(["* Thinking…"])).toBe("Thinking…");
    expect(extractActivityLabel(["✻ Loading"])).toBe("Loading");
  });

  test("returns the LATEST matching line when multiple appear in scrollback", () => {
    const got = extractActivityLabel([
      "✻ Cooked for 4s",
      "some other content",
      "✻ Baked for 9s",
    ]);
    expect(got).toBe("Baked for 9s");
  });

  test("ignores user input lines that contain the word 'for'", () => {
    expect(extractActivityLabel([
      "❯ wait for the build to finish",
      "─────────────────────",
    ])).toBeNull();
  });

  test("only scans the tail (~25 lines) — old activity beyond the window is ignored", () => {
    // 30 lines, with the only Cooked match at the top. Should NOT be found.
    const lines30 = ["✻ Cooked for 99s", ...Array(30).fill("regular chat")];
    expect(extractActivityLabel(lines30)).toBeNull();
  });

  // ── The live status line ───────────────────────────────────────────────
  //
  // Every fixture below is real `tmux capture-pane` output taken from two
  // agents that were demonstrably working at the time. Before ACTIVITY_LIVE
  // every one of them returned null: the operator's room strip showed a bare
  // glyph, so "thinking hard" and "wedged for an hour" looked identical. That
  // is the bug these cover, and it was reported three times before it was
  // understood.

  test("extracts the live status line a working agent actually shows", () => {
    // Verbatim from apiary_fableboy while it was mid-turn.
    expect(extractActivityLabel(lines(`
⏺ Calling apiary… (ctrl+o to expand)
· Improvising… (10m 3s · ↓ 21.4k tokens)
─────────────────────
❯
─────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt
`))).toBe("Improvising… (10m 3s · ↓ 21.4k tokens)");
  });

  test("keeps the elapsed time and stream progress, not just the verb", () => {
    // The parenthesised group is the whole point: it is what separates an
    // agent that is moving from one that has stopped.
    const got = extractActivityLabel(["✻ Fluttering… (38s · ↓ 2.1k tokens)"]);
    expect(got).toBe("Fluttering… (38s · ↓ 2.1k tokens)");
    expect(got).toContain("38s");
  });

  test("does not depend on the verb, which rotates", () => {
    // A vocabulary list is what broke this. Any word must work, including
    // ones that do not exist yet.
    for (const verb of ["Improvising", "Fluttering", "Reticulating", "Cogitating", "Wombling"]) {
      expect(extractActivityLabel([`✻ ${verb}… (7s)`])).toBe(`${verb}… (7s)`);
    }
  });

  test("prefers the live line over a finished one left further up the pane", () => {
    // A pane holds the previous turn's "Sautéed for 12s" above the current
    // turn's live line. Reporting the finished one would tell the operator
    // about work that is already over.
    expect(extractActivityLabel(lines(`
✻ Sautéed for 12s
⏺ next turn starts here
✻ Reticulating… (2s)
`))).toBe("Reticulating… (2s)");
  });

  test("an idle pane still reports nothing, live pattern or not", () => {
    // The live pattern must not fire on ordinary transcript prose that
    // happens to contain an ellipsis.
    expect(extractActivityLabel(lines(`
⏺ I will wait…
─────────────────────
❯
─────────────────────
`))).toBeNull();
  });
});
