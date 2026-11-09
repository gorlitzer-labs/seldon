/**
 * Tests for re-joining a room whose session was lost.
 *
 * The bug: the SSE loop retried with the session token it started with. After
 * the room server restarted that token was invalid, so sends failed with
 * "Invalid session token" (401) and the stream never came back; and when the
 * URL the agent joined with died (an expired tunnel) while the room was still
 * up on 127.0.0.1, every call failed with "fetch failed" and the agent's seat
 * stayed in the room as a ghost.
 *
 * These drive the real join handler, data source and SSE multiplexer against
 * an in-process fake of the room server's HTTP surface.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { EventProcessor } from "../src/agent/event-processor.js";
import { SseMultiplexer } from "../src/agent/sse-multiplexer.js";
import { RoomConnectionError } from "../src/agent/remote-room-data-source.js";
import { handleSendMessage, handleCatchUp } from "../src/agent/tool-handlers.js";
import { buildRuntimeMcpOptions, trackRoomEvent, type JoinResult } from "../src/cli/runtime-handlers.js";
import { isLoopbackUrl, localTierOf, readLocalRoomSession, type LocalRoomSession } from "../src/cli/rejoin.js";
import { createEvent, type ParticipantKickedEvent } from "../src/core/events.js";

const LOCAL = "http://127.0.0.1:7890";

/** The parts of `apiary serve` an agent's client talks to, held in memory. */
class FakeRoomServer {
  /** Origins that answer; any other one fails like a dead host. */
  live = new Set<string>([LOCAL]);
  shareTokens = new Set<string>(["share-1"]);
  sessions = new Map<string, string>(); // session token → participant id
  /** When set, /join answers with this status (a transient failure). */
  joinFailure: number | null = null;
  calls: Array<{ origin: string; method: string; path: string; token?: string; body?: Record<string, unknown> }> = [];
  private n = 0;
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

  /** Restart: every session token is gone; optionally new share tokens. */
  restart(newShareToken?: string): void {
    this.sessions.clear();
    if (newShareToken) this.shareTokens = new Set([newShareToken]);
    for (const s of this.streams) {
      try { s.close(); } catch { /* already closed */ }
    }
    this.streams.clear();
  }

  joins(): number {
    return this.calls.filter((c) => c.path === "/join").length;
  }

  sent(): Array<{ token?: string; content: unknown }> {
    return this.calls.filter((c) => c.path === "/message").map((c) => ({ token: c.token, content: c.body?.content }));
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers.Authorization?.replace(/^Bearer /, "");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ origin: url.origin, method, path: url.pathname, token, body });
    if (!this.live.has(url.origin)) throw new TypeError("fetch failed");

    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.pathname === "/join") {
      if (this.joinFailure) return json(this.joinFailure, { error: "Too many requests" });
      if (!this.shareTokens.has(String(body?.token ?? ""))) return json(403, { error: "Invalid share token" });
      const id = `agent_${++this.n}`;
      const sessionToken = `sess-${this.n}`;
      this.sessions.set(sessionToken, id);
      return json(200, {
        sessionToken,
        participantId: id,
        roomName: "hive",
        roomId: "hive",
        authority: "member",
        participants: [{ id, name: String(body?.name), type: "agent", authority: "member" }],
      });
    }
    if (url.pathname === "/rules") return json(404, { error: "not found" });
    if (!token || !this.sessions.has(token)) return json(401, { error: "Invalid session token" });

    switch (url.pathname) {
      case "/message":
        return json(200, { ok: true, messageId: `msg-${++this.n}` });
      case "/events/history":
        return json(200, { items: [], has_more: false, next_cursor: null });
      case "/participants":
        return json(200, { participants: [] });
      case "/events": {
        const signal = init.signal;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.streams.add(controller);
            signal?.addEventListener("abort", () => {
              this.streams.delete(controller);
              try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ }
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      default:
        return json(200, { ok: true });
    }
  };
}

interface Harness {
  server: FakeRoomServer;
  jr: JoinResult;
  processor: EventProcessor;
  sseMux: SseMultiplexer;
  logs: string[];
  send: (content: string) => Promise<string>;
}

const muxes: SseMultiplexer[] = [];

async function joinedAgent(opts: {
  url?: string;
  server?: FakeRoomServer;
  readRoomSession?: (name: string) => LocalRoomSession | null;
  now?: () => number;
} = {}): Promise<Harness> {
  const server = opts.server ?? new FakeRoomServer();
  vi.stubGlobal("fetch", server.fetch);
  const sseMux = new SseMultiplexer({ initialBackoffMs: 5, maxBackoffMs: 20 });
  muxes.push(sseMux);
  const processor = new EventProcessor("", "sprouts", { defaultMode: "everyone", pullOnly: true });
  const joinResults: JoinResult[] = [];
  const logs: string[] = [];
  const options = buildRuntimeMcpOptions({
    processor,
    sseMux,
    joinResults,
    agentName: "sprouts",
    authority: undefined,
    log: (l) => logs.push(l),
    rejoinOverrides: {
      sleep: async () => {},
      retryDelaysMs: [],
      readRoomSession: opts.readRoomSession ?? (() => null),
      ...(opts.now ? { now: opts.now } : {}),
    },
  });
  const joined = await options.onJoinRoom!(opts.url ?? `${LOCAL}/?token=share-1`);
  expect(joined.success).toBe(true);
  const send = async (content: string) => {
    const r = await handleSendMessage(processor, { room: "hive", content }, {});
    return r.content.map((c) => ("text" in c ? c.text : "")).join("");
  };
  return { server, jr: joinResults[0], processor, sseMux, logs, send };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  for (const m of muxes.splice(0)) m.close();
  vi.unstubAllGlobals();
});

describe("re-join after the room server restarts", () => {
  test("a 401 re-joins under the same name, swaps the token everywhere and retries the send once", async () => {
    const h = await joinedAgent();
    expect(h.jr.sessionToken).toBe("sess-1");
    expect(h.jr.rejoin).toMatchObject({ shareToken: "share-1", name: "sprouts", type: "agent", serverRoomName: "hive" });
    const update = vi.spyOn(h.sseMux, "updateConnection");

    h.server.restart();
    expect(await h.send("merged and deployed")).toMatch(/^Message sent/);

    const join = h.server.calls.filter((c) => c.path === "/join").at(-1)!;
    expect(join.body).toMatchObject({ token: "share-1", name: "sprouts", type: "agent" });
    const newToken = h.jr.sessionToken;
    expect(newToken).not.toBe("sess-1");
    expect(h.jr.dataSource.sessionToken).toBe(newToken);
    expect(update).toHaveBeenCalledWith("hive", LOCAL, newToken);
    // The new seat is who the agent is now: its own messages stay its own.
    expect(h.jr.participantId).toBe(h.server.sessions.get(newToken));
    expect(h.jr.dataSource.selfId).toBe(h.jr.participantId);
    expect(h.processor.participantId).toBe(h.jr.participantId);
    // One failed send, one retried with the new token. Never a third.
    expect(h.server.sent()).toEqual([
      { token: "sess-1", content: "merged and deployed" },
      { token: newToken, content: "merged and deployed" },
    ]);
    expect(h.logs.join("\n")).toMatch(/re-joined as "sprouts"/);
  });

  test("catch_up re-joins too, rather than showing an empty room", async () => {
    const h = await joinedAgent();
    h.server.restart();
    const r = await handleCatchUp(h.processor, { room: "hive" }, {});
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(h.server.joins()).toBe(2);
    const reads = h.server.calls.filter((c) => c.path === "/events/history");
    expect(reads.map((c) => c.token)).toEqual(["sess-1", "sess-1", h.jr.sessionToken]);
  });

  test("the event stream re-joins by itself and reconnects with the new token", async () => {
    const h = await joinedAgent();
    await until(() => h.server.calls.some((c) => c.path === "/events" && c.token === "sess-1"));
    h.server.restart();
    await until(() => h.server.calls.some((c) => c.path === "/events" && c.token === h.jr.sessionToken && c.token !== "sess-1"));
    expect(h.server.joins()).toBe(2);
    // and a send afterwards needs no further re-join
    expect(await h.send("back")).toMatch(/^Message sent/);
    expect(h.server.joins()).toBe(2);
  });

  test("a 401 for a token another caller already replaced is just retried", async () => {
    const h = await joinedAgent();
    h.server.restart();
    await Promise.all([h.send("one"), h.send("two")]);
    expect(h.server.joins()).toBe(2);
  });

  test("403 Invalid share token is a clear error and is not retried in a loop", async () => {
    const h = await joinedAgent();
    await until(() => h.server.calls.some((c) => c.path === "/events"));
    h.server.restart("share-2"); // the room was recreated: the old link is dead

    const err = await h.send("hello").catch((e) => e);
    expect(err).toBeInstanceOf(RoomConnectionError);
    expect(err.permanent).toBe(true);
    expect(err.message).toMatch(/no longer accepts the share link.*403 Invalid share token.*new share URL/);
    const joinsAfterFirst = h.server.joins();

    // Further calls fail at once with the same reason, and the event stream
    // stops instead of hammering /join.
    const again = await h.send("hello?").catch((e) => e);
    expect(again.message).toBe(err.message);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.server.joins()).toBe(joinsAfterFirst);
    expect(h.sseMux.hasConnection("hive")).toBe(false);
    expect(h.logs.join("\n")).toMatch(/giving up/);
  });

  test("after a restart mints new room tokens, the same-tier token in the local session file is used", async () => {
    const server = new FakeRoomServer();
    let file: LocalRoomSession = { serverUrl: LOCAL, memberToken: "share-1", adminToken: "admin-1" };
    const h = await joinedAgent({ server, readRoomSession: () => file });
    expect(h.jr.rejoin.localTier).toBe("member");

    server.restart("share-2");
    file = { serverUrl: LOCAL, memberToken: "share-2", adminToken: "admin-2" };
    expect(await h.send("still here")).toMatch(/^Message sent/);
    const joinTokens = server.calls.filter((c) => c.path === "/join").map((c) => c.body?.token);
    expect(joinTokens).toEqual(["share-1", "share-1", "share-2"]);
    expect(joinTokens).not.toContain("admin-2"); // never a higher tier
    expect(h.jr.rejoin.shareToken).toBe("share-2");
  });

  test("an agent that was kicked is not re-joined behind the admin's back", async () => {
    const h = await joinedAgent();
    trackRoomEvent(h.jr, createEvent<ParticipantKickedEvent>({
      type: "ParticipantKicked",
      category: "PRESENCE",
      room_id: "hive",
      participant_id: h.jr.participantId,
      participant: { id: h.jr.participantId, name: "sprouts", status: "online", type: "agent" },
      kicked_by: "sam",
    }));
    h.server.sessions.clear(); // the kick revoked the token
    const err = await h.send("let me back").catch((e) => e);
    expect(err).toBeInstanceOf(RoomConnectionError);
    expect(err.message).toMatch(/removed from room "hive" by sam/);
    expect(h.server.joins()).toBe(1);
  });

  test("two sessions with one name do not evict each other forever", async () => {
    let t = 1_000_000;
    const h = await joinedAgent({ now: () => t });
    h.server.restart();
    expect(await h.send("one")).toMatch(/^Message sent/);
    t += 5_000;
    h.server.sessions.clear(); // our new seat was taken over again at once
    const err = await h.send("two").catch((e) => e);
    expect(err.message).toMatch(/taken over again.*"sprouts"/);
    expect(h.server.joins()).toBe(2);
  });

  test("transient failures back off instead of retrying every call", async () => {
    let t = 1_000_000;
    const h = await joinedAgent({ now: () => t });
    h.sseMux.removeConnection("hive"); // keep the stream out of the count
    h.server.restart();
    h.server.joinFailure = 429; // the server is back but rate-limits joins
    const first = await h.send("a").catch((e) => e);
    expect(first).toBeInstanceOf(RoomConnectionError);
    expect(first.permanent).toBe(false);
    expect(first.message).toMatch(/could not re-join yet: 429/);
    const joins = h.server.joins();
    const second = await h.send("b").catch((e) => e);
    expect(second).toBeInstanceOf(RoomConnectionError);
    expect(second.message).toMatch(/retries in \d+s/);
    expect(h.server.joins()).toBe(joins);

    t += 60_000;
    h.server.joinFailure = null;
    expect(await h.send("c")).toMatch(/^Message sent/);
  });
});

describe("falling back from a dead URL to the room's local address", () => {
  const TUNNEL = "https://gone-away.trycloudflare.com";

  test("moves to 127.0.0.1 from the room's session file, keeping the same seat", async () => {
    const server = new FakeRoomServer();
    server.live.add(TUNNEL);
    const h = await joinedAgent({
      server,
      url: `${TUNNEL}/?token=share-1`,
      readRoomSession: () => ({ serverUrl: LOCAL, publicUrl: TUNNEL }),
    });
    server.live.delete(TUNNEL); // the tunnel expired; the server is still up

    expect(await h.send("still here")).toMatch(/^Message sent/);
    expect(h.jr.serverUrl).toBe(LOCAL);
    expect(h.jr.dataSource.serverUrl).toBe(LOCAL);
    expect(h.jr.sessionToken).toBe("sess-1"); // same session: no ghost, no new seat
    expect(server.joins()).toBe(1);
    expect(h.logs.join("\n")).toMatch(/unreachable, moved to http:\/\/127\.0\.0\.1:7890/);
  });

  test("never falls back to a host that is not 127.0.0.1 or localhost", async () => {
    const server = new FakeRoomServer();
    server.live.add(TUNNEL);
    server.live.add("http://10.0.0.5:7890");
    const h = await joinedAgent({
      server,
      url: `${TUNNEL}/?token=share-1`,
      readRoomSession: () => ({ serverUrl: "http://10.0.0.5:7890" }),
    });
    server.live.delete(TUNNEL);
    await expect(h.send("x")).rejects.toThrow(/fetch failed/);
    expect(server.calls.some((c) => c.origin === "http://10.0.0.5:7890")).toBe(false);
  });

  test("helpers: loopback only, same-tier only, plain room names only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isLoopbackUrl("http://localhost:7890")).toBe(true);
    expect(isLoopbackUrl("http://100.64.1.2:7890")).toBe(false);
    expect(isLoopbackUrl("https://x.trycloudflare.com")).toBe(false);
    expect(localTierOf("m", { memberToken: "m", adminToken: "a" })).toBe("member");
    expect(localTierOf("a", { memberToken: "m", adminToken: "a" })).toBe("admin");
    expect(localTierOf("other", { memberToken: "m", adminToken: "a" })).toBeUndefined();
    expect(readLocalRoomSession("../../etc/passwd")).toBeNull();
    expect(readLocalRoomSession("no-such-room-here")).toBeNull();
  });
});
