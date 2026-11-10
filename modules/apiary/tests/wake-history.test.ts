/**
 * The waker must wake only for live events, never for replayed history.
 *
 * Found live on 1.15.0: a session restarted, joined "sprouts-joey" as
 * "sprouts", posted a message, and its own pane got
 * `apiary: new messages in room "sprouts-joey" from sprouts`. The server held
 * one "sprouts" seat and the new message was from it. The culprit was
 * yesterday's message from an OLDER "sprouts" seat (same name, another id):
 * `apiary serve` replays the room's last 50 events on every stream connect,
 * and the waker took the replay for live traffic. The sender id was not the
 * agent's own, so "never wake for your own messages" did not catch it.
 *
 * These drive the real join handler, SSE multiplexer and waker against a fake
 * room server that replays history the way `apiary serve` does.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { EventProcessor } from "../src/agent/event-processor.js";
import { SseMultiplexer } from "../src/agent/sse-multiplexer.js";
import type { LabeledEvent } from "../src/agent/multiplexer.js";
import { buildRuntimeMcpOptions, type JoinResult } from "../src/cli/runtime-handlers.js";
import { McpWaker } from "../src/cli/mcp/wake.js";
import { wakeSource } from "../src/cli/mcp/wake-source.js";
import { handleCatchUp } from "../src/agent/tool-handlers.js";

const LOCAL = "http://127.0.0.1:7890";
const YESTERDAY = new Date(Date.now() - 24 * 3600_000);

function messageEvent(id: string, senderId: string, senderName: string, content: string, at = new Date()) {
  return {
    id: `ev-${id}`,
    type: "MessageSent",
    category: "MESSAGE",
    room_id: "sprouts-joey",
    participant_id: senderId,
    timestamp: at.toISOString(),
    message: { id, room_id: "sprouts-joey", sender_id: senderId, sender_name: senderName, content, reply_to_id: null, timestamp: at.toISOString() },
  };
}

function mentionEvent(id: string, targetId: string, senderId: string, senderName: string, at = new Date()) {
  return {
    id: `ev-mention-${id}`,
    type: "Mentioned",
    category: "MENTION",
    room_id: "sprouts-joey",
    participant_id: targetId,
    timestamp: at.toISOString(),
    message: { id, room_id: "sprouts-joey", sender_id: senderId, sender_name: senderName, content: "@sprouts hi", reply_to_id: null, timestamp: at.toISOString() },
  };
}

/** `apiary serve`'s join / history / stream, with history replayed on every stream connect. */
class ReplayingServer {
  history: Array<Record<string, unknown>> = [];
  historyFails = false;
  connects = 0;
  private n = 0;
  private live = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();

  /** A new event: stored in history and sent to every open stream. */
  post(event: Record<string, unknown>): void {
    this.history.push(event);
    for (const c of this.live) c.enqueue(this.enc.encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  /** Drop every open stream (the client reconnects and gets the replay again). */
  dropStreams(): void {
    for (const c of this.live) { try { c.close(); } catch { /* closed */ } }
    this.live.clear();
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", Date: new Date().toUTCString() },
      });
    switch (url.pathname) {
      case "/join": {
        const body = JSON.parse(String(init.body));
        const id = `agent_new${++this.n}`;
        return json(200, {
          sessionToken: `sess-${this.n}`, participantId: id, roomName: "sprouts-joey", roomId: "sprouts-joey",
          authority: "member",
          participants: [
            { id, name: body.name, type: "agent" },
            { id: "agent_joey", name: "joey", type: "agent" },
          ],
        });
      }
      case "/events/history":
        if (this.historyFails) return json(500, { error: "boom" });
        return json(200, { items: [...this.history].reverse(), has_more: false, next_cursor: null });
      case "/events": {
        this.connects++;
        const signal = init.signal;
        const replay = this.history.slice(-50);
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => {
            for (const e of replay) c.enqueue(this.enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            this.live.add(c);
            signal?.addEventListener("abort", () => {
              this.live.delete(c);
              try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ }
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      case "/rules":
        return json(404, {});
      default:
        return json(200, { ok: true, messageId: `msg-${++this.n}` });
    }
  };
}

const muxes: SseMultiplexer[] = [];
afterEach(() => {
  for (const m of muxes.splice(0)) m.close();
  vi.unstubAllGlobals();
});

async function joined(server: ReplayingServer) {
  vi.stubGlobal("fetch", server.fetch);
  const sseMux = new SseMultiplexer({ initialBackoffMs: 5, maxBackoffMs: 20 });
  muxes.push(sseMux);
  const processor = new EventProcessor("", "sprouts", { defaultMode: "everyone", pullOnly: true });
  const joinResults: JoinResult[] = [];
  const nudges: string[] = [];
  const waker = new McpWaker({ nudge: (t) => nudges.push(t) }, {
    plainDelayMs: 0,
    isSeen: (id) => processor.isEventSeen(id),
  });
  const options = buildRuntimeMcpOptions({
    processor, sseMux, joinResults, agentName: "sprouts", authority: undefined,
    rejoinOverrides: { readRoomSession: () => null },
  });
  const source = wakeSource(sseMux, { joinResults, processor, waker });
  const it = source[Symbol.asyncIterator]();
  const received: LabeledEvent[] = [];
  const pump = (async () => {
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      received.push(r.value);
    }
  })();
  void pump;
  const res = await options.onJoinRoom!(`${LOCAL}/?token=m`, undefined, "sprouts");
  expect(res.success).toBe(true);
  /** Wait until `n` events have gone through the waker. */
  const through = async (n: number) => {
    const start = Date.now();
    while (received.length < n) {
      if (Date.now() - start > 2000) throw new Error(`only ${received.length}/${n} events arrived`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { jr: joinResults[0], processor, nudges, waker, received, through };
}

function seededServer(): ReplayingServer {
  const server = new ReplayingServer();
  // Yesterday: the agent's OLDER seat (same name, another id) and joey talked.
  server.post(messageEvent("old1", "agent_56c712f6", "sprouts", "status from yesterday", YESTERDAY));
  server.post(messageEvent("old2", "agent_joey", "joey", "ok, noted", YESTERDAY));
  server.post(mentionEvent("old2", "agent_56c712f6", "agent_joey", "joey", YESTERDAY));
  return server;
}

describe("the waker ignores the history the stream replays", () => {
  test("joining, then posting: the replay of an older same-named seat never wakes the agent (the 1.15.0 bug)", async () => {
    const server = seededServer();
    const h = await joined(server);
    await h.through(3);
    // The agent posts 1 s after joining; its own message comes back on the stream.
    server.post(messageEvent("mine", h.jr.participantId, "sprouts", "posted right after joining"));
    await h.through(4);
    expect(h.nudges).toEqual([]);
  });

  test("a live message from someone else after the join still wakes it", async () => {
    const server = seededServer();
    const h = await joined(server);
    await h.through(3);
    server.post(messageEvent("live1", "agent_joey", "joey", "merged and deployed"));
    await h.through(4);
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]).toContain('new messages in room "sprouts-joey" from joey');
  });

  test("a replayed @mention from history does not wake it either", async () => {
    const server = new ReplayingServer();
    server.post(messageEvent("m1", "agent_joey", "joey", "@sprouts hi", YESTERDAY));
    server.post(mentionEvent("m1", "agent_new1", "agent_joey", "joey", YESTERDAY));
    const h = await joined(server);
    await h.through(2);
    expect(h.nudges).toEqual([]);
  });

  test("a stream reconnect replays history again, and it still does not wake it", async () => {
    const server = seededServer();
    const h = await joined(server);
    await h.through(3);
    server.post(messageEvent("live1", "agent_joey", "joey", "one live message"));
    await h.through(4);
    expect(h.nudges).toHaveLength(1);
    await handleCatchUp(h.processor, { room: "sprouts-joey" }, {});
    h.waker.caughtUp("sprouts-joey");

    server.dropStreams();
    await h.through(8); // the same four events, replayed
    expect(h.nudges).toHaveLength(1);
  });

  test("if the join's history read failed, the server-clock cutoff still keeps history quiet", async () => {
    const server = seededServer();
    server.historyFails = true;
    const h = await joined(server);
    expect(h.jr.liveSince).toBeGreaterThan(Date.now() - 60_000);
    await h.through(3);
    expect(h.nudges).toEqual([]);
  });
});

describe("own messages when the self id is not known yet", () => {
  test("a message under the agent's own name does not wake it when there is no id to compare", () => {
    const nudges: string[] = [];
    const waker = new McpWaker({ nudge: (t) => nudges.push(t) }, { plainDelayMs: 0 });
    const ev = messageEvent("x1", "agent_whoever", "sprouts", "mine") as never;
    expect(waker.onEvent("r", ev, "", [], "everyone", { selfName: "sprouts" })).toBe(false);
    expect(nudges).toEqual([]);
  });

  test("with a self id, the id decides: someone else under the same name is not the agent", () => {
    const nudges: string[] = [];
    const waker = new McpWaker({ nudge: (t) => nudges.push(t) }, { plainDelayMs: 0 });
    const ev = messageEvent("x2", "agent_other", "sprouts", "a different sprouts") as never;
    expect(waker.onEvent("r", ev, "agent_me", [], "everyone", { selfName: "sprouts" })).toBe(true);
  });
});
