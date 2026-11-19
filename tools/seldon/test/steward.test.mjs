import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stewardCommand, stewardGuard, STEWARD_ALLOWED, STEWARD_BRIEF } from "../lib/steward.mjs";
import { wsRows } from "../lib/workspace.mjs";

test("the steward asks before anything outside seldon, even when your sessions bypass permissions", () => {
  const argv = stewardCommand({ brief: "B" });
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
  assert.ok(STEWARD_ALLOWED.every((t) => /^Bash\(seldon /.test(t)), "only seldon commands run without asking");
  const denied = argv[argv.indexOf("--disallowedTools") + 1].split(",");
  for (const t of ["Edit", "Write"]) assert.ok(denied.includes(t), `${t} is denied without a scratch folder`);
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
});

test("with a scratch folder, file tools are allowed there only, and a guard hook denies the rest", () => {
  const argv = stewardCommand({ brief: "B", scratch: "/h/.seldon/steward/scratch", guard: "node seldon.js steward guard" });
  const allowed = argv[argv.indexOf("--allowedTools") + 1].split(",");
  assert.ok(allowed.includes("Edit(//h/.seldon/steward/scratch/**)"), "one Edit(path) rule: Claude applies it to every file tool");
  assert.ok(!allowed.some((t) => /^(Write|MultiEdit)\(/.test(t)), "Claude ignores Write(path) rules and warns");
  assert.ok(!allowed.some((t) => /^(Write|Edit)$/.test(t)), "never the bare tool");
  assert.ok(argv[argv.indexOf("--disallowedTools") + 1].split(",").includes("NotebookEdit"));
  const hook = JSON.parse(argv[argv.indexOf("--settings") + 1]).hooks.PreToolUse[0];
  assert.match(hook.matcher, /Write/); assert.match(hook.matcher, /Edit/);
  assert.equal(hook.hooks[0].command, "node seldon.js steward guard");
});

test("the guard lets the steward write in scratch and nowhere else", () => {
  const s = "/h/.seldon/steward/scratch";
  const w = (file_path, tool_name = "Write") => stewardGuard({ tool_name, tool_input: { file_path } }, s);
  assert.equal(w(`${s}/notes.md`), null);
  assert.equal(w(`${s}/deep/a.txt`, "Edit"), null);
  for (const p of ["/h/.claude.json", "/h/.claude/settings.json", "/h/.seldon/steward/scratch-x/a", `${s}/../a`, "/h/.seldon/steward/.claude/settings.local.json"])
    assert.ok(w(p), `${p} is denied`);
  assert.ok(stewardGuard({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/x.ipynb" } }, s));
  assert.ok(stewardGuard({ tool_name: "Write", tool_input: {} }, s), "no path is denied");
  assert.equal(stewardGuard({ tool_name: "Bash", tool_input: { command: "seldon lanes" } }, s), null, "other tools: the normal rules");
});

test("the guard follows a symlink out of scratch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const s = path.join(dir, "scratch"); fs.mkdirSync(s);
  fs.symlinkSync(os.homedir(), path.join(s, "out"));
  assert.ok(stewardGuard({ tool_name: "Write", tool_input: { file_path: path.join(s, "out", ".claude.json") } }, s));
  assert.equal(stewardGuard({ tool_name: "Write", tool_input: { file_path: path.join(s, "new", "n.md") } }, s), null);
  fs.rmSync(dir, { recursive: true });
});

test("the brief keeps the steward away from trust and settings", () => {
  assert.match(STEWARD_BRIEF, /Never edit ~\/\.claude\.json/);
});

test("the brief keeps the rules that make relaying safe", () => {
  assert.match(STEWARD_BRIEF, /Never decide for Franco/);
  assert.match(STEWARD_BRIEF, /Never type into an agent that is working/);
});

test("the steward is pinned at the top of the list, before anyone waiting", () => {
  const lane = (name, state) => ({ key: name, name, state, harness: "claude" });
  const rows = wsRows([{ name: "p", lanes: [lane("joey", "needs-you"), lane("steward", "idle"), lane("tars", "working")] }]);
  assert.deepEqual(rows.map((r) => [r.n, r.name, r.group]), [[1, "steward", "steward"], [2, "joey", "needs you"], [3, "tars", "working"]]);
});

test("the feed batches new waits, waits for the steward to be free, and never repeats or self-reports", async () => {
  const { stewardFeed, BATCH_MS } = await import("../lib/steward.mjs");
  const L = (name, state) => ({ key: name, name, state });
  let q = [], now = 1e12, r;
  const lanes = (stew, ...rest) => [L("steward", stew), ...rest];
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you")), now);           q = r.queue;
  assert.equal(r.say, null, "not before the batch window");
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you"), L("joey", "needs-you")), now + 30e3); q = r.queue;
  assert.equal(r.say, null);
  r = stewardFeed(q, lanes("working", L("wheel", "needs-you"), L("joey", "needs-you")), now + BATCH_MS + 1); q = r.queue;
  assert.equal(r.say, null, "never while the steward is busy");
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you"), L("joey", "needs-you")), now + BATCH_MS + 2); q = r.queue;
  assert.match(r.say, /wheel, joey/);
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you"), L("joey", "needs-you")), now + 3 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "the same waits are not told twice");
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you"), L("joey", "needs-you")), now + 4.2 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "…not even after another full batch window");
  r = stewardFeed(q, lanes("idle", L("wheel", "working")), now + 6 * BATCH_MS); q = r.queue;   // wheel was answered
  const again = { ...L("wheel", "needs-you"), lastMessageAt: now + 7 * BATCH_MS };   // it asked something new
  r = stewardFeed(q, lanes("idle", again), now + 7 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, lanes("idle", again), now + 8 * BATCH_MS + 1);
  assert.match(r.say || "", /wheel/, "a new wait after it was answered is news again");
  assert.equal(stewardFeed([], lanes("needs-you"), now + 11 * BATCH_MS).say, null, "the steward is never told about itself");
  assert.equal(stewardFeed([], [L("wheel", "needs-you")], now).say, null, "no steward running: nothing to tell");
});

test("relay log: the steward's session is marked, and the log reads newest first", async () => {
  const { stewardEnv, relayLine, recentRelays } = await import("../lib/steward.mjs");
  assert.ok(stewardEnv("/p").includes("SELDON_STEWARD=1"), "messages sent from the steward's session are logged");
  const log = relayLine("joey", "deploy to QA", 1) + "not json\n" + relayLine("tars", "use staging.x.com", 2);
  assert.deepEqual(recentRelays(log).map((e) => e.to), ["tars", "joey"]);
  assert.equal(recentRelays(log, 1).length, 1);
});

test("telegram out: a new finished steward message goes once; start-up and busy turns send nothing", async () => {
  const { stewardOutbox, QUIET_MS } = await import("../lib/steward.mjs");
  const now = 1e12;
  let r = stewardOutbox(undefined, { state: "idle", text: "old", at: now - 1e6 }, now);
  assert.equal(r.send, null, "starting up never re-sends the last message");
  r = stewardOutbox(r.seen, { state: "working", text: "3 things need you…", at: now }, now + QUIET_MS + 1);
  assert.equal(r.send, null, "not while it is still working");
  r = stewardOutbox(r.seen, { state: "idle", text: "3 things need you…", at: now }, now + 1000);
  assert.equal(r.send, null, "not while the file is still being written");
  r = stewardOutbox(r.seen, { state: "idle", text: "3 things need you…", at: now }, now + QUIET_MS + 1);
  assert.equal(r.send, "3 things need you…");
  assert.equal(stewardOutbox(r.seen, { state: "idle", text: "3 things need you…", at: now }, now + 9e5).send, null, "never twice");
});

test("telegram in: your lines wait for the steward to be free, then go in together", async () => {
  const { stewardInbox, FROM_PHONE } = await import("../lib/steward.mjs");
  assert.equal(stewardInbox(["1 yes"], "working").say, null);
  const r = stewardInbox(["1 yes", "2 wait till tonight"], "idle");
  assert.equal(r.say, `${FROM_PHONE} 1 yes · 2 wait till tonight`);
  assert.deepEqual(r.queue, []);
});

test("each bot has its own config: the steward's never touches the main bot's chat", async () => {
  const { configFile } = await import("../lib/telegram.mjs");
  assert.match(configFile(), /telegram\.json$/);
  assert.match(configFile("steward"), /telegram-steward\.json$/);
  assert.notEqual(configFile("steward"), configFile());
});

test("stewardHtml: no agent-card header, wrapped lines joined, items apart with names bold, the question bold", async () => {
  const { stewardHtml } = await import("../lib/telegram.mjs");
  const real = "Nothing is waiting on you right now.\ntars is idle. Its earlier question is the one from before: should it build the keys? You haven't answered it yet. Tell me\nyes or no and I'll pass it on.";
  const h = stewardHtml(real);
  assert.ok(h.startsWith("🦚 <b>steward</b>"));
  assert.doesNotMatch(h, /INFO|▸/, "not an agent card");
  assert.match(h, /Tell me yes or no/, "the terminal wrap is joined back");
  const list = stewardHtml("3 things need you:\n\n1. joey: deploy to QA now?\n2. wheel: merge #196?\n\nWhich first?");
  assert.match(list, /<b>1\. joey<\/b> · deploy to QA now\?\n\n<b>2\. wheel<\/b> · merge #196\?/);
  assert.match(list, /<b>Which first\?<\/b>$/);
});

test("steward feed: a working/needs-you flicker on the same wait is not news; a new question is", async () => {
  const { stewardFeed, BATCH_MS } = await import("../lib/steward.mjs");
  const L = (name, state, extra = {}) => ({ key: name, name, state, ...extra });
  const stew = L("steward", "idle");
  const ask = (at, w = "permission: Bash") => L("wheel", "needs-you", { waitingFor: w, lastMessageAt: at });
  let q = [], now = 1e12, r;
  r = stewardFeed(q, [stew, ask(5)], now); q = r.queue;
  r = stewardFeed(q, [stew, ask(5)], now + BATCH_MS + 1); q = r.queue;
  assert.match(r.say || "", /wheel/);
  r = stewardFeed(q, [stew, L("wheel", "working")], now + BATCH_MS + 2); q = r.queue;   // a flicker
  r = stewardFeed(q, [stew, ask(5)], now + BATCH_MS + 3); q = r.queue;
  r = stewardFeed(q, [stew, ask(5)], now + 3 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "the same wait after a flicker is not told again");
  r = stewardFeed(q, [stew, ask(5, "permission: Edit")], now + 4 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, ask(5, "permission: Edit")], now + 5.1 * BATCH_MS); q = r.queue;
  assert.match(r.say || "", /wheel/, "a different question is news");
  r = stewardFeed(q, [stew, ask(9, "permission: Edit")], now + 6 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, ask(9, "permission: Edit")], now + 7.1 * BATCH_MS); q = r.queue;
  assert.match(r.say || "", /wheel/, "a newer message is news");
});

test("steward feed: a failed poll changes nothing, and a briefly missing lane keeps its told memory", async () => {
  const { stewardFeed, BATCH_MS, TOLD_GONE_MS } = await import("../lib/steward.mjs");
  const L = (name, state, extra = {}) => ({ key: name, name, state, ...extra });
  const stew = L("steward", "idle");
  const ask = L("wheel", "needs-you", { waitingFor: "a question", lastMessageAt: 5 });
  let q = [], now = 1e12, r;
  r = stewardFeed(q, [stew, ask], now); q = r.queue;
  const failed = stewardFeed(q, null, now + 1);
  assert.equal(failed.say, null);
  assert.equal(failed.queue, q, "a failed read (lanes = null) keeps queue and told as they were");
  r = stewardFeed(q, [stew, ask], now + BATCH_MS + 1); q = r.queue;
  assert.match(r.say || "", /wheel/);
  r = stewardFeed(q, [stew], now + BATCH_MS + 2); q = r.queue;             // lane missing for a poll
  r = stewardFeed(q, [stew, ask], now + BATCH_MS + 3); q = r.queue;
  r = stewardFeed(q, [stew, ask], now + 3 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "not re-announced after a brief absence");
  r = stewardFeed(q, [stew], now + 4 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew], now + 4 * BATCH_MS + TOLD_GONE_MS + 1); q = r.queue;
  assert.equal(q.told.length, 0, "forgotten once gone for good");
});

test("the brief makes the steward check live state before every answer about who needs Franco", () => {
  assert.match(STEWARD_BRIEF, /[Bb]efore ANY answer[\s\S]{0,120}seldon lanes --json fresh/);
  assert.match(STEWARD_BRIEF, /never answer from earlier messages/i);
  assert.match(STEWARD_BRIEF, /no longer waiting/);
  assert.match(STEWARD_BRIEF, /handled/);
});

test("steward feed: a told wait that ends is reported once, after the batch window, and a flicker is not", async () => {
  const { stewardFeed, BATCH_MS } = await import("../lib/steward.mjs");
  const L = (name, state, extra = {}) => ({ key: name, name, state, ...extra });
  const stew = L("steward", "idle");
  const ask = L("joey", "needs-you", { waitingFor: "a question", lastMessageAt: 5 });
  let q = [], now = 1e12, r;
  r = stewardFeed(q, [stew, ask], now); q = r.queue;
  r = stewardFeed(q, [stew, ask], now + BATCH_MS + 1); q = r.queue;
  assert.match(r.say || "", /waiting on Franco now: joey/);
  // Franco answered joey directly: it works for a moment, then flickers back to the same wait
  r = stewardFeed(q, [stew, L("joey", "working")], now + BATCH_MS + 2); q = r.queue;
  assert.equal(r.say, null, "not at once: it may be a flicker");
  r = stewardFeed(q, [stew, ask], now + BATCH_MS + 5e3); q = r.queue;
  r = stewardFeed(q, [stew, ask], now + 3 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "a flicker back to the same wait is not news either way");
  // now really answered
  r = stewardFeed(q, [stew, L("joey", "working")], now + 4 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, L("joey", "working")], now + 4.5 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "still inside the window");
  r = stewardFeed(q, [L("steward", "working"), L("joey", "working")], now + 5.1 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "never while the steward is busy");
  r = stewardFeed(q, [stew, L("joey", "working")], now + 5.2 * BATCH_MS); q = r.queue;
  assert.equal(r.say, "seldon: joey is no longer waiting (working again): drop it, do not ask Franco about it.");
  r = stewardFeed(q, [stew, L("joey", "working")], now + 8 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "said once");
  // the same question shows up again after it was dropped: news, the steward was told to forget it
  r = stewardFeed(q, [stew, ask], now + 9 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, ask], now + 10.1 * BATCH_MS); q = r.queue;
  assert.match(r.say || "", /waiting on Franco now: joey/);
});

test("steward feed: ends and new waits go in one line; a stopped or vanished agent is reported too", async () => {
  const { stewardFeed, BATCH_MS, TOLD_GONE_MS } = await import("../lib/steward.mjs");
  const L = (name, state, extra = {}) => ({ key: name, name, state, ...extra });
  const stew = L("steward", "idle");
  const w = (n) => L(n, "needs-you", { waitingFor: "a question", lastMessageAt: 1 });
  let q = [], now = 1e12, r;
  r = stewardFeed(q, [stew, w("joey"), w("tars"), w("keen")], now); q = r.queue;
  r = stewardFeed(q, [stew, w("joey"), w("tars"), w("keen")], now + BATCH_MS + 1); q = r.queue;
  assert.match(r.say, /joey, tars, keen/);
  r = stewardFeed(q, [stew, L("joey", "idle"), L("tars", "stopped"), w("keen"), w("wheel")], now + 2 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, L("joey", "idle"), L("tars", "stopped"), w("keen"), w("wheel")], now + 3.1 * BATCH_MS); q = r.queue;
  assert.equal(r.say, "seldon: waiting on Franco now: wheel. Read them and tell him in one message. No longer waiting: joey (done), tars (stopped): drop them, do not ask Franco about them.");
  // keen's session is destroyed: missing from every poll
  r = stewardFeed(q, [stew, w("wheel")], now + 4 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, [stew, w("wheel")], now + 5 * BATCH_MS); q = r.queue;
  assert.equal(r.say, null, "a lane missing for a while may come back");
  r = stewardFeed(q, [stew, w("wheel")], now + 4 * BATCH_MS + TOLD_GONE_MS + 1); q = r.queue;
  assert.equal(r.say, "seldon: keen is no longer waiting (stopped): drop it, do not ask Franco about it.");
  assert.ok(!q.told.some((t) => t.key === "keen"), "and then forgotten");
});

test("staleness: phone messages too old are not relayed, and agents' notes are delivered once across restarts", async () => {
  const { freshForSteward, STALE_IN_MS, notesSince } = await import("../lib/steward.mjs");
  const now = 1e12;
  assert.equal(freshForSteward(now - 5_000, now), true);
  assert.equal(freshForSteward(now - STALE_IN_MS - 1, now), false, "a replayed old Telegram message does not reach the steward");
  const jsonl = [{ from: "a", kind: "info", text: "old", at: 10 }, { from: "b", kind: "info", text: "new", at: 20 }].map((n) => JSON.stringify(n)).join("\n") + "\nnot json\n";
  assert.deepEqual(notesSince(jsonl, 10).map((n) => n.text), ["new"]);
  assert.deepEqual(notesSince(jsonl, 0).map((n) => n.text), ["old", "new"]);
});

test("lanes carry the time of their last message, so a new question can be told apart", async () => {
  const { markAsking } = await import("../lib/lanes.mjs");
  const lane = { harness: "claude", sessionId: "s", state: "needs-you", waitingFor: "you" };
  const [l] = markAsking([lane], () => ({ text: "ok", mtime: 42 }), 1e6);
  assert.equal(l.lastMessageAt, 42);
});
