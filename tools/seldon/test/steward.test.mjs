import { test } from "node:test";
import assert from "node:assert/strict";
import { stewardCommand, STEWARD_ALLOWED, STEWARD_DENIED, STEWARD_BRIEF } from "../lib/steward.mjs";
import { wsRows } from "../lib/workspace.mjs";

test("the steward asks before anything outside seldon, even when your sessions bypass permissions", () => {
  const argv = stewardCommand({ brief: "B" });
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
  assert.ok(STEWARD_ALLOWED.every((t) => /^Bash\(seldon /.test(t)), "only seldon commands run without asking");
  for (const t of ["Edit", "Write"]) assert.ok(STEWARD_DENIED.includes(t), `${t} is denied`);
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
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
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you")), now + 7 * BATCH_MS); q = r.queue;
  r = stewardFeed(q, lanes("idle", L("wheel", "needs-you")), now + 8 * BATCH_MS + 1);
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
