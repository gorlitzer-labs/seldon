/**
 * Knowing whether a message actually got into the agent.
 *
 * Both bridges used to type and assume. On 2026-09-10 that turned one swallowed
 * Enter into seven minutes of apparent silence: the message sat in a Codex
 * composer while apiary reported success, and an agent that had never received
 * anything looked like one refusing to answer.
 *
 * A submitted message moves into the transcript; an unsubmitted one is still in
 * the composer. These tests hold that distinction, and hold that a message which
 * cannot be delivered is reported rather than swallowed.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { composerStillHolds, composerBlock, submissionProbe } from "../src/cli/composer.js";

const keys: string[] = [];
const undelivered: string[] = [];

// State is read BEFORE injecting and the composer is read AFTER, so a single
// fixed screen cannot express "was idle, then the message got stuck". Screens
// are consumed in order; the last one repeats.
let screens: string[][] = [];
function nextScreen(): string[] {
  return screens.length > 1 ? (screens.shift() as string[]) : (screens[0] ?? []);
}

vi.mock("../src/cli/tmux.js", () => ({
  tmuxCapturePane: () => nextScreen(),
  tmuxInjectText: (_s: string, t: string) => { keys.push(`text:${t}`); },
  tmuxInjectPaste: (_s: string, t: string) => { keys.push(`paste:${t}`); },
  tmuxSendEnter: () => { keys.push("Enter"); },
  tmuxSendKey: (_s: string, k: string) => { keys.push(`key:${k}`); },
  tmuxPaneIsShell: () => false,
  trimTrailingBlankLines: (l: string[]) => l,
}));
vi.mock("../src/cli/codex/queue.js", () => ({
  queueCodexMessage: () => false,   // force the composer path
  findCodexSessionId: () => null,
}));

const { CodexTmuxBridge } = await import("../src/cli/codex/tmux-bridge.js");
const { TmuxBridge } = await import("../src/cli/claude/tmux-bridge.js");

const MSG = "[12:15:31] #6485 [shipyard] Franco: sooo @all";
const text = (s: string) => [{ type: "text" as const, text: s }];

/** The message submitted: it is in the transcript, the composer is empty again. */
const SUBMITTED = [
  `› ${MSG}`,
  "• Parsed mention: @all.",
  "› Ask Codex to do anything",
];
/** The message stuck: the composer still holds it. */
const STUCK = [
  "• an earlier reply",
  `› ${MSG}`,
];

/** Claude's composer: a ❯ prompt with a separator line under it. */
const claudeScreen = (composer: string) => [
  "⏺ an earlier reply",
  "────────────────────────────────────────",
  `❯ ${composer}`,
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];
const CLAUDE_IDLE = claudeScreen("");
const CLAUDE_STUCK = claudeScreen(MSG);

beforeEach(() => {
  keys.length = 0;
  undelivered.length = 0;
  screens = [SUBMITTED];
});

describe("composer reading", () => {
  test("the composer is the last prompt-marked block, not the transcript", () => {
    expect(composerBlock(SUBMITTED)).toBe("› Ask Codex to do anything");
    expect(composerBlock(STUCK)).toContain(MSG);
  });

  test("text in the transcript is not text in the composer", () => {
    // The same message appears on both screens. Only one of them is a failure.
    expect(composerStillHolds(SUBMITTED, MSG)).toBe(false);
    expect(composerStillHolds(STUCK, MSG)).toBe(true);
  });

  test("reads Claude's prompt marker too", () => {
    expect(composerStillHolds([`❯ ${MSG}`], MSG)).toBe(true);
  });

  test("survives the composer wrapping a long message", () => {
    const wrapped = ["› [12:15:31] #6485 [shipyard] Franco: sooo", "  @all and then some more text"];
    expect(composerStillHolds(wrapped, MSG)).toBe(true);
  });

  test("a message too short to probe is never called undelivered", () => {
    // A false 'undelivered' makes the caller resend; a duplicate room message is
    // worse than an unchecked one.
    expect(submissionProbe("ok").length).toBeLessThan(8);
    expect(composerStillHolds(["› ok"], "ok")).toBe(false);
  });
});

describe("Codex bridge", () => {
  test("says nothing when the message submitted", async () => {
    screens = [SUBMITTED];
    const b = new CodexTmuxBridge("a", { onUndelivered: (t) => undelivered.push(t) });
    await b.deliver(text(MSG));
    expect(undelivered).toEqual([]);
    b.stop();
  });

  test("presses Enter again when the message is still in the composer", async () => {
    // One entry per screen read, in order: detectState, the popup check,
    // confirmSubmitted (stuck), confirmSubmitted again after the retry Enter.
    screens = [SUBMITTED, SUBMITTED, STUCK, SUBMITTED];
    const b = new CodexTmuxBridge("a", { onUndelivered: (t) => undelivered.push(t) });
    await b.deliver(text(MSG));
    // first Enter, then the retry Enter
    expect(keys.filter((k) => k === "Enter").length).toBe(2);
    expect(undelivered).toEqual([]);   // the retry got it in
    b.stop();
  });

  test("reports a message it could not deliver instead of reporting success", async () => {
    // detectState, popup check, then stuck on every read from here on
    screens = [SUBMITTED, SUBMITTED, STUCK];
    const b = new CodexTmuxBridge("a", { onUndelivered: (t) => undelivered.push(t) });
    await b.deliver(text(MSG));
    expect(undelivered).toEqual([MSG]);
    b.stop();
  });
});

describe("Claude bridge", () => {
  test("no longer fires a blind second Enter when the first one worked", async () => {
    screens = [CLAUDE_IDLE];
    const b = new TmuxBridge("a", { onUndelivered: (t) => undelivered.push(t) });
    await b.deliver(text(MSG));
    expect(keys.filter((k) => k === "Enter").length).toBe(1);
    expect(undelivered).toEqual([]);
    b.stop();
  });

  test("retries, then reports, when the message stays in the composer", async () => {
    screens = [CLAUDE_IDLE, CLAUDE_STUCK];
    const b = new TmuxBridge("a", { onUndelivered: (t) => undelivered.push(t) });
    await b.deliver(text(MSG));
    expect(keys.filter((k) => k === "Enter").length).toBe(2);
    expect(undelivered).toEqual([MSG]);
    b.stop();
  });
});
