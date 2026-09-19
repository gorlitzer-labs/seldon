/**
 * Delivering a room message through Codex rather than through its composer.
 *
 * Typing into the composer is what made "sooo @all" arrive as
 * "sooo @Openai-Templates" on 2026-09-10: Codex read the payload as typing,
 * the `@` opened the mention popup, and Enter selected a plugin instead of
 * submitting. `codex queue` hands the message to the session directly, so
 * none of that machinery is in the path.
 *
 * These tests hold two things: that we only ever address a session we can
 * actually prove is ours, and that the composer stays the fallback rather
 * than the default.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findCodexSessionId,
  parseSessionMeta,
  queueCodexMessage,
} from "../src/cli/codex/queue.js";

let root: string;

/** Write a rollout file the way Codex does: session_meta on the first line. */
function writeRollout(
  name: string,
  meta: { sessionId: string; cwd: string; startedAt: string },
  dir = join(root, "2026", "09", "17"),
): void {
  mkdirSync(dir, { recursive: true });
  const record = {
    timestamp: meta.startedAt,
    type: "session_meta",
    payload: { session_id: meta.sessionId, cwd: meta.cwd, timestamp: meta.startedAt },
  };
  writeFileSync(join(dir, name), JSON.stringify(record) + "\n{}\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apiary-codex-sessions-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseSessionMeta", () => {
  test("reads a real session_meta record", () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { session_id: "abc", cwd: "/work", timestamp: "2026-09-17T08:27:39.699Z" },
    });
    expect(parseSessionMeta(line)).toEqual({
      sessionId: "abc",
      cwd: "/work",
      startedAt: Date.parse("2026-09-17T08:27:39.699Z"),
    });
  });

  test("is not fooled by another record type or by junk", () => {
    expect(parseSessionMeta(JSON.stringify({ type: "response_item" }))).toBeNull();
    expect(parseSessionMeta("not json")).toBeNull();
  });
});

describe("findCodexSessionId", () => {
  const cwd = "/work/stranded";
  const launch = Date.parse("2026-09-17T10:00:00.000Z");

  test("finds the session started in our directory after we launched", () => {
    writeRollout("rollout-a.jsonl", {
      sessionId: "ours",
      cwd,
      startedAt: "2026-09-17T10:00:03.000Z",
    });
    expect(findCodexSessionId({ cwd, startedAfter: launch, sessionsDir: root })).toBe("ours");
  });

  test("ignores a session in a different directory", () => {
    writeRollout("rollout-b.jsonl", {
      sessionId: "someone-else",
      cwd: "/work/other",
      startedAt: "2026-09-17T10:00:03.000Z",
    });
    expect(findCodexSessionId({ cwd, startedAfter: launch, sessionsDir: root })).toBeNull();
  });

  test("ignores a session that predates our launch", () => {
    // Franco's own Codex, open in the same repo before the agent started.
    writeRollout("rollout-c.jsonl", {
      sessionId: "his-own",
      cwd,
      startedAt: "2026-09-17T09:30:00.000Z",
    });
    expect(findCodexSessionId({ cwd, startedAfter: launch, sessionsDir: root })).toBeNull();
  });

  test("allows a little clock slack, since Codex stamps the session after launch", () => {
    writeRollout("rollout-d.jsonl", {
      sessionId: "just-before",
      cwd,
      startedAt: "2026-09-17T09:59:58.000Z",
    });
    expect(findCodexSessionId({ cwd, startedAfter: launch, sessionsDir: root })).toBe("just-before");
  });

  test("returns null rather than guessing when nothing matches", () => {
    expect(findCodexSessionId({ cwd, startedAfter: launch, sessionsDir: root })).toBeNull();
  });
});

describe("queueCodexMessage", () => {
  test("passes the message through verbatim", () => {
    const calls: Array<[string, string]> = [];
    const ok = queueCodexMessage("thread-1", "sooo @all", (t, m) => { calls.push([t, m]); });
    expect(ok).toBe(true);
    expect(calls).toEqual([["thread-1", "sooo @all"]]);
  });

  test("reports failure instead of throwing, so the caller can fall back", () => {
    const ok = queueCodexMessage("thread-1", "sooo @all", () => { throw new Error("no such thread"); });
    expect(ok).toBe(false);
  });
});
