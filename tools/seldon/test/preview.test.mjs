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
  assert.deepEqual(previewKeys({ state: "idle", lane: { tmuxSession: "joey" } }, parseOptions(Q)).map(([k]) => k), ["a", "⏎", "x"], "an idle agent can be replied to, without option keys");
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

test("askOf: the question the message ends on, not one asked earlier", async () => {
  const { askOf } = await import("../lib/preview.mjs");
  assert.equal(askOf("Merged #938.\n\n- Rules: published 0.28.0.\n- QA: needs a qa branch. Want me to do that now?"), "Want me to do that now?");
  assert.equal(askOf("Should I? I checked and it is fine.\n\nAll done."), null);
  assert.equal(askOf("Which one?\n\n1. a\n2. b"), "Which one?");
});

test("formatBody: bullets hang, refs and versions marked, every line fits", async () => {
  const { formatBody } = await import("../lib/preview.mjs");
  const mark = (t) => (x) => `<${t}>${x}</${t}>`;
  const lines = formatBody("- Rules package: sprouts merged their rules PR and published joey-rules 0.28.0 in commit b7c26c1, see #938", 40,
    { ref: mark("r"), version: mark("v"), bold: mark("b"), code: mark("c"), dim: (x) => x });
  const plain = lines.map((l) => l.replace(/<\/?\w>/g, ""));
  assert.ok(plain[0].startsWith("• Rules"), plain[0]);
  assert.ok(plain.slice(1).every((l) => l.startsWith("  ")), "wrapped lines hang under the text");
  assert.ok(plain.every((l) => l.length <= 40));
  const all = lines.join(" ");
  assert.match(all, /<v>0\.28\.0<\/v>/); assert.match(all, /<r>b7c26c1<\/r>/); assert.match(all, /<r>#938<\/r>/);
});

test("summaryOf: a long message shows its end, and says it cut", async () => {
  const { summaryOf } = await import("../lib/preview.mjs");
  assert.deepEqual(summaryOf("one\n\ntwo"), { text: "one\n\ntwo", cut: false });
  assert.deepEqual(summaryOf("a\n\nb\n\nlast part"), { text: "last part", cut: true });
});

test("markAsking: a turn that ended on a question waits on you; mid-turn or still writing does not", async () => {
  const { markAsking, endsWithQuestion } = await import("../lib/lanes.mjs");
  const said = (text, extra = []) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }, ...extra] } });
  const ask = said("Merged. Want me to deploy?") + "\n" + JSON.stringify({ type: "pr-link" });
  assert.equal(endsWithQuestion(ask), true);
  assert.equal(endsWithQuestion(said("Let me check, shall I run the suite first?", [{ type: "tool_use" }])), false, "a question with a tool call after it: still working");
  assert.equal(endsWithQuestion(ask + "\n" + JSON.stringify({ type: "user", message: { content: "yes" } })), false, "you already answered");
  const lane = { harness: "claude", sessionId: "s", state: "working" }, now = 1e12;
  assert.equal(markAsking([lane], () => ({ text: ask, mtime: now - 60_000 }), now)[0].state, "needs-you");
  assert.equal(markAsking([lane], () => ({ text: ask, mtime: now - 5_000 }), now)[0].state, "working", "still writing");
});

test("agoWords: when the message was written, in words", async () => {
  const { agoWords } = await import("../lib/preview.mjs");
  const now = 1e12;
  assert.equal(agoWords(now - 20e3, now), "just now");
  assert.equal(agoWords(now - 180e3, now), "3 min ago");
  assert.equal(agoWords(now - 2 * 3600e3, now), "2 h ago");
});

test("previewKeys: a stopped agent can be removed; the steward is stopped with S, not x", () => {
  assert.deepEqual(previewKeys({ state: "stopped", lane: {} }).map(([k]) => k), ["⏎", "r"]);
  assert.deepEqual(previewKeys({ state: "failed", lane: {} }).map(([k]) => k), ["⏎", "r"]);
  assert.ok(!previewKeys({ state: "working", lane: { tmuxSession: "t" } }).some(([k]) => k === "r"), "never remove a live agent");
  const st = previewKeys({ name: "steward", state: "idle", lane: { tmuxSession: "seldon_steward" } });
  assert.deepEqual(st.map(([k]) => k), ["a", "⏎", "S"]);
});
