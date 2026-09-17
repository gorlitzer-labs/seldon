/**
 * The @-mention popup guard.
 *
 * Codex decides paste-vs-typing partly on timing, so a bracketed paste can
 * still be read as typing on a loaded machine. A `@` read as a keystroke opens
 * the mention popup, where Enter INSERTS the highlighted completion instead of
 * submitting. On 2026-09-10 a room message reading "sooo @all" reached a Codex
 * agent as "sooo @Openai-Templates" (an installed plugin was the top hit) and
 * never submitted; the next message appended to the same stuck composer line.
 *
 * The bridge therefore checks the screen after pasting and presses Escape
 * first when the popup is up. These tests hold that order in place.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const keys: string[] = [];
let screen: string[] = [];

vi.mock("../src/cli/tmux.js", () => ({
  tmuxCapturePane: () => screen,
  tmuxInjectText: (_s: string, text: string) => { keys.push(`text:${text}`); },
  tmuxInjectPaste: (_s: string, text: string) => { keys.push(`paste:${text}`); },
  tmuxSendEnter: () => { keys.push("Enter"); },
  tmuxSendKey: (_s: string, key: string) => { keys.push(`key:${key}`); },
  tmuxPaneIsShell: () => false,
  trimTrailingBlankLines: (lines: string[]) => lines,
}));

const { CodexTmuxBridge, codexMentionPopupIsOpen } = await import(
  "../src/cli/codex/tmux-bridge.js"
);

/** An idle composer with the mention popup open over it. */
const POPUP_SCREEN = [
  "› sooo @all",
  "> Default templates   Default templates for documents, spreadsheets   Plugin",
  "  Skill Installer     Install curated skills from openai/skills       Skill",
  "  enter insert · esc close · ←/→ switch search modes      [All Results]   Plugins",
];

/** The same composer with no popup. */
const IDLE_SCREEN = ["› Ask Codex to do anything", "  gpt-6-astra medium · ~/stranded"];

const text = (s: string) => [{ type: "text" as const, text: s }];

beforeEach(() => {
  keys.length = 0;
  screen = IDLE_SCREEN;
});

describe("codexMentionPopupIsOpen", () => {
  test("recognises the popup by its footer", () => {
    expect(codexMentionPopupIsOpen(POPUP_SCREEN)).toBe(true);
  });

  test("an ordinary composer is not a popup", () => {
    expect(codexMentionPopupIsOpen(IDLE_SCREEN)).toBe(false);
  });

  test("does not fire on an agent quoting the footer far up the transcript", () => {
    const quoted = [
      "  the hint reads: enter insert · esc close",
      ...Array.from({ length: 25 }, (_, i) => `  transcript line ${i}`),
      "› Ask Codex to do anything",
    ];
    expect(codexMentionPopupIsOpen(quoted)).toBe(false);
  });
});

describe("delivery with the popup up", () => {
  test("presses Escape before Enter, so the message submits as written", async () => {
    screen = POPUP_SCREEN;
    const bridge = new CodexTmuxBridge("agent");
    await bridge.deliver(text("[12:15:31] #6485 [shipyard] Franco: sooo @all"));

    // The payload is pasted, the popup dismissed, and only then submitted.
    expect(keys).toEqual([
      "paste:[12:15:31] #6485 [shipyard] Franco: sooo @all",
      "key:Escape",
      "Enter",
    ]);
    bridge.stop();
  });

  test("sends no Escape when no popup is up — Escape is also Codex's interrupt", async () => {
    screen = IDLE_SCREEN;
    const bridge = new CodexTmuxBridge("agent");
    await bridge.deliver(text("hello, no mention here"));

    expect(keys).toEqual(["paste:hello, no mention here", "Enter"]);
    expect(keys).not.toContain("key:Escape");
    bridge.stop();
  });
});
