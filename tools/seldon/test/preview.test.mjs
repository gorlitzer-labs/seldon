import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions, previewKeys, previewBody, stateWords } from "../lib/preview.mjs";
import { wsRows } from "../lib/workspace.mjs";

const Q = "I've added the form.\n\nShould a URL go straight to the queue?\n\n1. straight to the queue\n2. **manual review** first";

test("parseOptions: a numbered run at the end is a question; a list mid-text or a lone item is not", () => {
  assert.deepEqual(parseOptions(Q).map((o) => o.label), ["straight to the queue", "manual review first"]);
  assert.deepEqual(parseOptions("Done.\n1. only one"), []);
  assert.deepEqual(parseOptions("1. a\n3. c"), []);
  const long = "1. a\n2. b\n" + "more text\n".repeat(15) + "All done.";
  assert.deepEqual(parseOptions(long), []);
});

test("previewKeys: answer keys only for a waiting tmux agent; a background session can only be opened", () => {
  const waiting = { state: "needs-you", lane: { tmuxSession: "botfighter" } };
  assert.deepEqual(previewKeys(waiting, parseOptions(Q)).map(([k]) => k), ["1", "2", "a", "⏎", "x"]);
  assert.deepEqual(previewKeys({ state: "needs-you", lane: { id: "c09d" } }, parseOptions(Q)).map(([k]) => k), ["⏎", "x"]);
  assert.ok(!previewKeys({ state: "working", lane: { tmuxSession: "t" } }).some(([k]) => k === "a"), "never type into a working agent");
  assert.deepEqual(previewKeys({ off: true, state: "idle", lane: {} }), []);
});

test("previewBody: wraps to the width, keeps the end, drops code", () => {
  const b = previewBody("intro\n```js\nlong code\n```\nShould a submitted URL go straight to the queue?", 20, 10);
  assert.ok(b.every((l) => l.length <= 20));
  assert.ok(b.includes("[code]"));
  assert.equal(previewBody("a\nb\nc\nd", 10, 2).join("|"), "c|d");
});

test("wsRows: grouped needs you → working → idle → paused, numbered in that order", () => {
  const lane = (name, state, extra = {}) => ({ key: name, name, state, harness: "claude", ...extra });
  const rows = wsRows([{ name: "p", lanes: [lane("idle1", "idle"), lane("busy", "working"), lane("ask", "needs-you")] },
    { name: "q", lanes: [lane("far", "idle", { machine: "mini" })] }], new Set(["mini"]));
  assert.deepEqual(rows.map((r) => [r.n, r.name, r.group]), [[1, "ask", "needs you"], [2, "busy", "working"], [3, "idle1", "idle"], [4, "far", "paused"]]);
  assert.equal(stateWords(rows[0]), "waiting for an answer");
  assert.equal(stateWords(rows[3]), "paused · mini is asleep");
});

test("gone: a background session with no saved conversation, older than 10 minutes, not at work", async () => {
  const { markGone } = await import("../lib/lanes.mjs");
  const now = 1e12, old = now - 60 * 60_000;
  const l = (o) => ({ harness: "claude", id: "c09d", sessionId: "s1", state: "needs-you", waitingFor: "you", startedAt: old, ...o });
  const none = () => false, saved = () => true;
  assert.equal(markGone([l()], none, now)[0].state, "gone");
  assert.equal(markGone([l()], saved, now)[0].state, "needs-you", "a saved conversation can be woken");
  assert.equal(markGone([l({ startedAt: now - 60_000 })], none, now)[0].state, "needs-you", "a young one may not have written yet");
  assert.equal(markGone([l({ state: "working" })], none, now)[0].state, "working");
  assert.equal(markGone([l({ id: null })], none, now)[0].state, "needs-you", "interactive sessions are never marked");
  const row = { state: "gone", lane: { id: "c09d" } };
  assert.deepEqual(previewKeys(row).map(([k]) => k), ["x"], "the only thing to do is remove it");
  assert.match(stateWords(row), /gone/);
  assert.equal(wsRows([{ name: "p", lanes: [{ ...l(), state: "gone", key: "k", name: "dead" }, { key: "a", name: "ok", state: "idle", harness: "claude" }] }]).map((r) => r.group).join(), "idle,gone");
});
