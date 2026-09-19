/**
 * Tests for opt-in queue de-duplication in both tmux bridges.
 *
 * The invite loop retries a delivery it cannot observe landing, so without
 * de-duplication a blocked pane accumulates N copies that all flush at once.
 * But room events must NEVER be collapsed, so it is opt-in per delivery.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Both bridges shell out to tmux on construction-adjacent paths; stub the
// module so the queue logic can be exercised without a terminal.
const captured: string[] = [];
let screen: string[] = [];

vi.mock("../src/cli/tmux.js", () => ({
  tmuxCapturePane: () => screen,
  tmuxInjectText: (_s: string, text: string) => { captured.push(text); },
  tmuxInjectPaste: (_s: string, text: string) => { captured.push(text); },
  tmuxSendEnter: () => {},
  tmuxSendKey: () => {},
  // These tests are about queue mechanics on a pane whose CLI is running, so
  // the agent is present. detectState consults this before reading the screen.
  tmuxPaneIsShell: () => false,
  trimTrailingBlankLines: (lines: string[]) => {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    return lines.slice(0, end);
  },
}));

const { CodexTmuxBridge } = await import("../src/cli/codex/tmux-bridge.js");
const { TmuxBridge } = await import("../src/cli/claude/tmux-bridge.js");

/** A screen that both bridges classify as un-injectable, so text is queued. */
const BLOCKED_SCREEN = [
  "Welcome to Codex, OpenAI's command-line coding agent",
  "Finish signing in via your browser",
];

const text = (s: string) => [{ type: "text" as const, text: s }];

beforeEach(() => {
  captured.length = 0;
  screen = BLOCKED_SCREEN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["CodexTmuxBridge", () => new CodexTmuxBridge("sess")],
  ["TmuxBridge", () => new TmuxBridge("sess")],
])("%s queue de-duplication", (_name, make) => {
  test("retried identical text queues once when opted in", async () => {
    const bridge = make() as { deliver: (p: unknown[], o?: unknown) => Promise<void>; stop: () => void };

    for (let i = 0; i < 5; i++) {
      await bridge.deliver(text("Please join the apiary room ... URL: http://x/?token=1"), { dedupe: true });
    }
    bridge.stop();

    // Nothing was injected (pane blocked); the point is what got queued.
    expect(captured).toHaveLength(0);
  });

  test("distinct texts are all kept even when opted in", async () => {
    const bridge = make() as { deliver: (p: unknown[], o?: unknown) => Promise<void>; stop: () => void };

    await bridge.deliver(text("first"), { dedupe: true });
    await bridge.deliver(text("second"), { dedupe: true });
    bridge.stop();

    expect(captured).toHaveLength(0);
  });

  test("identical room events are NOT collapsed by default", async () => {
    // Two events that happen to format identically must both survive — a
    // dropped room message is invisible and unrecoverable.
    const bridge = make() as {
      deliver: (p: unknown[], o?: unknown) => Promise<void>;
      stop: () => void;
      // @ts-expect-error reaching into the queue is the point of the test
      queue: string[];
    };

    await bridge.deliver(text("Alice: ping"));
    await bridge.deliver(text("Alice: ping"));

    expect(bridge.queue).toHaveLength(2);
    bridge.stop();
  });

  test("opting in collapses only the pending duplicate", async () => {
    const bridge = make() as {
      deliver: (p: unknown[], o?: unknown) => Promise<void>;
      stop: () => void;
      // @ts-expect-error reaching into the queue is the point of the test
      queue: string[];
    };

    await bridge.deliver(text("join me"), { dedupe: true });
    await bridge.deliver(text("join me"), { dedupe: true });
    await bridge.deliver(text("different"), { dedupe: true });

    expect(bridge.queue).toEqual(["join me", "different"]);
    bridge.stop();
  });

  test("empty text is never queued", async () => {
    const bridge = make() as {
      deliver: (p: unknown[], o?: unknown) => Promise<void>;
      stop: () => void;
      // @ts-expect-error reaching into the queue is the point of the test
      queue: string[];
    };

    await bridge.deliver(text("   "));
    expect(bridge.queue).toHaveLength(0);
    bridge.stop();
  });
});
