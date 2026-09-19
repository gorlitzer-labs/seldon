/**
 * Which delivery path the Codex bridge picks.
 *
 * Queue when we can name the session, composer when we cannot — and never
 * queue into a session nothing is reading.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const keys: string[] = [];
const queued: Array<[string, string]> = [];
let screen: string[] = [];
let paneIsShell = false;
let queueSucceeds = true;

vi.mock("../src/cli/tmux.js", () => ({
  tmuxCapturePane: () => screen,
  tmuxInjectText: (_s: string, t: string) => { keys.push(`text:${t}`); },
  tmuxInjectPaste: (_s: string, t: string) => { keys.push(`paste:${t}`); },
  tmuxSendEnter: () => { keys.push("Enter"); },
  tmuxSendKey: (_s: string, k: string) => { keys.push(`key:${k}`); },
  tmuxPaneIsShell: () => paneIsShell,
  trimTrailingBlankLines: (lines: string[]) => lines,
}));

vi.mock("../src/cli/codex/queue.js", () => ({
  queueCodexMessage: (threadId: string, text: string) => {
    queued.push([threadId, text]);
    return queueSucceeds;
  },
  findCodexSessionId: () => null,
}));

const { CodexTmuxBridge } = await import("../src/cli/codex/tmux-bridge.js");

const IDLE = ["› Ask Codex to do anything", "  gpt-6-astra medium · ~/stranded"];
const text = (s: string) => [{ type: "text" as const, text: s }];
const MSG = "[12:15:31] #6485 [shipyard] Franco: sooo @all";

beforeEach(() => {
  keys.length = 0;
  queued.length = 0;
  screen = IDLE;
  paneIsShell = false;
  queueSucceeds = true;
});

describe("delivery path", () => {
  test("queues through Codex when the session is known, touching no keys", async () => {
    const b = new CodexTmuxBridge("agent", { resolveThreadId: () => "thread-1" });
    await b.deliver(text(MSG));

    expect(queued).toEqual([["thread-1", MSG]]);
    expect(keys).toEqual([]);
    b.stop();
  });

  test("falls back to the composer when the session cannot be named", async () => {
    const b = new CodexTmuxBridge("agent", { resolveThreadId: () => null });
    await b.deliver(text(MSG));

    expect(queued).toEqual([]);
    expect(keys).toEqual([`paste:${MSG}`, "Enter"]);
    b.stop();
  });

  test("falls back to the composer when Codex refuses the queued message", async () => {
    queueSucceeds = false;
    const b = new CodexTmuxBridge("agent", { resolveThreadId: () => "thread-1" });
    await b.deliver(text(MSG));

    expect(queued).toEqual([["thread-1", MSG]]);
    expect(keys).toEqual([`paste:${MSG}`, "Enter"]);
    b.stop();
  });

  test("never queues into a pane whose CLI has exited — the message would vanish", async () => {
    paneIsShell = true;
    const b = new CodexTmuxBridge("agent", { resolveThreadId: () => "thread-1" });
    await b.deliver(text(MSG));

    expect(queued).toEqual([]);
    b.stop();
  });

  test("resolves the session once and remembers it", async () => {
    let calls = 0;
    const b = new CodexTmuxBridge("agent", {
      resolveThreadId: () => { calls++; return "thread-1"; },
    });
    await b.deliver(text("one"));
    await b.deliver(text("two"));

    expect(calls).toBe(1);
    expect(queued.map((q) => q[1])).toEqual(["one", "two"]);
    b.stop();
  });

  test("keeps retrying resolution while the session is still starting", async () => {
    let calls = 0;
    const b = new CodexTmuxBridge("agent", {
      resolveThreadId: () => { calls++; return calls >= 2 ? "thread-1" : null; },
    });
    await b.deliver(text("early"));   // Codex still booting — composer
    await b.deliver(text("later"));   // session exists now — queue

    expect(queued).toEqual([["thread-1", "later"]]);
    expect(keys).toEqual(["paste:early", "Enter"]);
    b.stop();
  });
});
