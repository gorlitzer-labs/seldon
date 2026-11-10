/**
 * Tests for remembering an `apiary mcp` session's rooms across a restart.
 *
 * A restarted Claude Code session started `apiary mcp` with no rooms, so the
 * agent silently left every room until someone pasted join_room again.
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoomMemory,
  memoryKey,
  memoryPath,
  resolveRememberConfig,
  restoreCandidates,
  restoreRooms,
  type RememberedRoom,
} from "../src/cli/mcp/remember.js";
import type { JoinResult } from "../src/cli/runtime-handlers.js";

function joined(over: Partial<JoinResult["rejoin"]> = {}, roomName = "hive"): JoinResult {
  return {
    roomName,
    rejoin: {
      joinUrl: "http://127.0.0.1:7890/?token=share-1",
      shareToken: "share-1",
      name: "sprouts",
      type: "agent",
      serverRoomName: "hive",
      localTier: "member",
      ...over,
    },
  } as JoinResult;
}

function freshMemory(): RoomMemory {
  return new RoomMemory(join(mkdtempSync(join(tmpdir(), "apiary-mem-")), "mcp-rooms", "k.json"));
}

describe("resolveRememberConfig", () => {
  test("on by default", () => {
    expect(resolveRememberConfig({}).enabled).toBe(true);
  });
  test("APIARY_MCP_REMEMBER=off opts out", () => {
    expect(resolveRememberConfig({ APIARY_MCP_REMEMBER: "off" })).toEqual({ enabled: false, reason: "APIARY_MCP_REMEMBER=off" });
  });
  test("off under a test runner unless a test opts in", () => {
    expect(resolveRememberConfig({ VITEST: "true" }).enabled).toBe(false);
    expect(resolveRememberConfig({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(resolveRememberConfig({ VITEST: "true", APIARY_MCP_REMEMBER: "on" }).enabled).toBe(true);
  });
});

describe("memoryKey: who this agent is, across a restart", () => {
  test("inside tmux: the pane's session, window and pane, so two panes in one session differ", () => {
    expect(memoryKey({ TMUX_PANE: "%7" }, "/x", () => "work:1.0")).toBe("tmux-work_1.0");
    expect(memoryKey({ TMUX_PANE: "%8" }, "/x", () => "work:1.1")).toBe("tmux-work_1.1");
  });
  test("outside tmux (or if tmux cannot say): the working directory", () => {
    const a = memoryKey({}, "/repo/a");
    expect(a).toMatch(/^cwd-[0-9a-f]{16}$/);
    expect(memoryKey({}, "/repo/a")).toBe(a);
    expect(memoryKey({}, "/repo/b")).not.toBe(a);
    expect(memoryKey({ TMUX_PANE: "%7" }, "/repo/a", () => null)).toBe(a);
  });
  test("a hostile session name cannot escape the directory", () => {
    expect(memoryKey({ TMUX_PANE: "%7" }, "/x", () => "../../etc/passwd")).not.toContain("/");
  });
  test("the file lives under the (sandboxed) HOME, never the developer's real one", () => {
    expect(memoryPath("k")).toBe(join(homedir(), ".apiary", "mcp-rooms", "k.json"));
    expect(homedir()).not.toBe(process.env.APIARY_TEST_REAL_HOME);
  });
});

describe("RoomMemory", () => {
  test("remembers a room once, refreshes it, and forgets it", () => {
    const m = freshMemory();
    m.remember(joined());
    m.remember(joined({ shareToken: "share-2" }));
    expect(m.list()).toHaveLength(1);
    expect(m.list()[0]).toMatchObject({
      roomName: "hive", joinUrl: "http://127.0.0.1:7890/", shareToken: "share-2", name: "sprouts", type: "agent", localTier: "member",
    });
    expect(m.list()[0].alias).toBeUndefined();
    m.forget("hive");
    expect(m.list()).toEqual([]);
  });
  test("keeps an alias when the agent joined under one", () => {
    const m = freshMemory();
    m.remember(joined({}, "my-alias"));
    expect(m.list()[0]).toMatchObject({ roomName: "hive", alias: "my-alias" });
  });
  test("the file holds share tokens, so only its owner can read it", () => {
    const m = freshMemory();
    m.remember(joined());
    expect(statSync(m.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(m.file, "utf-8")).version).toBe(1);
  });
  test("a corrupt file reads as no rooms", () => {
    const m = new RoomMemory(join(mkdtempSync(join(tmpdir(), "apiary-mem-")), "nope.json"));
    expect(m.list()).toEqual([]);
  });
});

describe("restoring rooms", () => {
  const room: RememberedRoom = {
    roomName: "hive", joinUrl: "https://gone.trycloudflare.com/", shareToken: "share-1", localTier: "member",
    name: "sprouts", type: "agent", savedAt: "",
  };

  test("tries the remembered link, then the room's same-tier token on 127.0.0.1 — never another tier or host", () => {
    const urls = restoreCandidates(room, { serverUrl: "http://127.0.0.1:7890", memberToken: "share-2", adminToken: "admin-2" });
    expect(urls).toEqual([
      "https://gone.trycloudflare.com/?token=share-1",
      "http://127.0.0.1:7890/?token=share-2",
      "http://127.0.0.1:7890/?token=share-1",
    ]);
    expect(restoreCandidates(room, { serverUrl: "http://10.0.0.5:7890", memberToken: "share-2" }))
      .toEqual(["https://gone.trycloudflare.com/?token=share-1"]);
  });

  test("rejoins under the remembered name and says so", async () => {
    const calls: Array<[string, string | undefined, string]> = [];
    const notes = await restoreRooms([room], {
      join: async (url, alias, name) => { calls.push([url, alias, name]); return { success: true }; },
      forget: () => { throw new Error("must not forget a room that came back"); },
      log: () => {},
      readRoomSession: () => null,
    });
    expect(calls).toEqual([["https://gone.trycloudflare.com/?token=share-1", undefined, "sprouts"]]);
    expect(notes).toEqual(['Rejoined room "hive" from your last session, as "sprouts".']);
  });

  test("a room that does not answer is skipped and kept for next time", async () => {
    const forgotten: string[] = [];
    const logs: string[] = [];
    const notes = await restoreRooms([room], {
      join: async () => ({ success: false, error: "Unable to connect. Is the server running?" }),
      forget: (r) => forgotten.push(r),
      log: (l) => logs.push(l),
      readRoomSession: () => null,
    });
    expect(forgotten).toEqual([]);
    expect(notes[0]).toMatch(/did not answer, so you are not in it/);
    expect(logs[0]).toMatch(/unreachable; skipped/);
  });

  test("a room that rejects the link for good is forgotten", async () => {
    const forgotten: string[] = [];
    const notes = await restoreRooms([room], {
      join: async () => ({ success: false, error: 'Failed to join: {"error":"Invalid share token"}' }),
      forget: (r) => forgotten.push(r),
      log: () => {},
      readRoomSession: () => null,
    });
    expect(forgotten).toEqual(["hive"]);
    expect(notes[0]).toMatch(/no longer accepts its share link/);
  });
});
