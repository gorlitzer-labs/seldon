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
});
