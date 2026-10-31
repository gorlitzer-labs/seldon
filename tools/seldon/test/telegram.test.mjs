import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chunks, chatFromUpdates, mediaKind, fileFromMessage, inboxName, noteLine, card, watchCard, mdToHtml, htmlToPlain, sendCard } from "../lib/telegram.mjs";

const BIN = fileURLToPath(new URL("../bin/seldon.js", import.meta.url));

test("chunks: one piece when it fits, split at a line break near the limit otherwise", () => {
  assert.deepEqual(chunks("hi"), ["hi"]);
  assert.deepEqual(chunks(""), []);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ` + "x".repeat(20)).join("\n");
  const parts = chunks(lines, 200);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.ok(parts.every((p) => !p.startsWith("\n")));
  assert.equal(parts.join("\n"), lines);
  assert.deepEqual(chunks("y".repeat(10), 4), ["yyyy", "yyyy", "yy"]);   // no line break: hard cut
});

test("chatFromUpdates: the private chat that wrote last", () => {
  const u = (id, type = "private", name = "sam") => ({ message: { chat: { id, type, username: name } } });
  assert.deepEqual(chatFromUpdates({ result: [u(1), u(-100, "group"), u(2, "private", "ana")] }), { id: 2, name: "ana" });
  assert.equal(chatFromUpdates({ result: [u(-100, "group")] }), null);
  assert.equal(chatFromUpdates({ result: [] }), null);
  assert.equal(chatFromUpdates(null), null);
});

test("seldon tell without a token says how to store it, and never runs on", () => {
  const home = mkdtempSync(join(tmpdir(), "seldon-tell-"));    // never the real ~/.seldon
  const env = { ...process.env, SELDON_HOME: home, SELDON_TELL_VIA_COMB: "1" };
  delete env.TELEGRAM_BOT_TOKEN;
  try {
    const r = spawnSync(process.execPath, [BIN, "tell", "hi"], { env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /comb set TELEGRAM_BOT_TOKEN/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("mediaKind: each file shows up the way it should", () => {
  assert.equal(mediaKind("shot.PNG").method, "sendPhoto");
  assert.equal(mediaKind("/out/pitch.mp4").method, "sendVideo");
  assert.equal(mediaKind("demo.gif").method, "sendAnimation");
  assert.equal(mediaKind("vo.mp3").method, "sendAudio");
  assert.equal(mediaKind("report.pdf").method, "sendDocument");
  assert.equal(mediaKind("Makefile").method, "sendDocument");
});

test("fileFromMessage: the file a message carries, the largest photo size", () => {
  const photo = { photo: [{ file_id: "s", file_size: 1 }, { file_id: "l", file_size: 9 }] };
  assert.deepEqual(fileFromMessage(photo), { fileId: "l", size: 9, name: "photo.jpg" });
  assert.equal(fileFromMessage({ document: { file_id: "d", file_name: "report.pdf" } }).name, "report.pdf");
  assert.equal(fileFromMessage({ video: { file_id: "v" } }).name, "video.mp4");
  assert.equal(fileFromMessage({ voice: { file_id: "o" } }).name, "voice.ogg");
  assert.equal(fileFromMessage({ text: "hi" }), null);
  assert.equal(fileFromMessage(undefined), null);
});

test("inboxName: time first, and never a path out of the folder", () => {
  const at = new Date(2026, 9, 31, 9, 15, 2);
  assert.equal(inboxName("shot.png", at), "20261031-091502-shot.png");
  assert.equal(inboxName("../../.ssh/authorized_keys", at), "20261031-091502-authorized_keys");
  assert.equal(inboxName("..\\..\\x.png", at), "20261031-091502-x.png");
  assert.equal(inboxName(".env", at), "20261031-091502-env");
  assert.equal(inboxName("My Shot (1).png", at), "20261031-091502-My_Shot_1_.png");
});

test("noteLine: one line per thing, a link for files", () => {
  const at = new Date(2026, 9, 31, 9, 15);
  assert.equal(noteLine(at, { text: "look\nat this" }), "- 2026-10-31 09:15 · look ⏎ at this\n");
  assert.equal(noteLine(at, { file: "a b.png", text: "bug" }), "- 2026-10-31 09:15 · [a b.png](a%20b.png) — bug\n");
  assert.equal(noteLine(at, { file: "x.png" }), "- 2026-10-31 09:15 · [x.png](x.png)\n");
});

test("card: a coloured kind, where it is from, and what happened — escaped", () => {
  const c = card({ kind: "done", project: "weather", branch: "lane/add-cache", text: "PR #4 merged <ok>", machine: "mini" });
  assert.equal(c, "🟢 <b>DONE</b> · <b>weather</b> <i>(lane/add-cache)</i>\nPR #4 merged &lt;ok&gt;\n<i>💻 mini</i>");
  assert.match(card({ kind: "need" }), /^🟠 <b>NEEDS YOU<\/b>$/);
  assert.match(card({ kind: "nonsense" }), /^🔵 <b>INFO/);
  assert.match(card({ link: 'https://x.ts.net:8443/"><b>' }), /href="https:\/\/x\.ts\.net:8443\/&quot;&gt;&lt;b&gt;"/);
});

test("card: a log shows its tail, and the whole stays inside the limit", () => {
  const log = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const c = card({ kind: "fail", text: "tests broke", log, max: 1024 });
  const visible = c.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot);/g, "x");
  assert.ok(visible.length <= 1024, `visible ${visible.length}`);
  assert.match(c, /line 1999<\/pre>/);       // the end of the log, not the start
  assert.doesNotMatch(c, /line 0\n/);
});

test("watchCard: the watcher's events in words", () => {
  const lane = { name: "fix-save", harness: "codex", project: "/w/stranded", waitingFor: "permission: Bash", startedAt: 0 };
  const need = watchCard({ to: "needs-you", lane }, { machine: "mini", link: "https://m.ts.net:8443/", now: 12 * 60_000 });
  assert.deepEqual(need, { kind: "need", project: "stranded", lane: "fix-save", harness: "codex", detail: "permission: Bash", age: null, machine: "mini", link: "https://m.ts.net:8443/" });
  const done = watchCard({ to: "idle", lane: { ...lane, startedAt: 60_000 } }, { now: 12 * 60_000 });
  assert.equal(done.kind, "done");
  assert.equal(done.age, "running 11m");
  assert.equal(watchCard({ to: "failed", lane }).kind, "fail");
});

test("mdToHtml: the Markdown agents write, as Telegram shows it", () => {
  assert.equal(mdToHtml("**bold** *it* _it_ ~~gone~~ ||hush|| `x<y`"),
    "<b>bold</b> <i>it</i> <i>it</i> <s>gone</s> <tg-spoiler>hush</tg-spoiler> <code>x&lt;y</code>");
  assert.equal(mdToHtml("# Title"), "<b>Title</b>");
  assert.equal(mdToHtml("- one\n  * two\n1. three"), "• one\n  • two\n1. three");
  assert.equal(mdToHtml("> a\n> b\nafter"), "<blockquote>a\nb</blockquote>\nafter");
  assert.equal(mdToHtml("---"), "──────────");
  assert.equal(mdToHtml("see [PR](https://github.com/o/r/pull/1?a=1&b=2)"), 'see <a href="https://github.com/o/r/pull/1?a=1&amp;b=2">PR</a>');
});

test("mdToHtml: code blocks keep their language and their text as written", () => {
  assert.equal(mdToHtml("```js\nif (a < b && c) **x**\n```"), '<pre><code class="language-js">if (a &lt; b &amp;&amp; c) **x**</code></pre>');
  assert.equal(mdToHtml("```\nnever closed"), "<pre><code>never closed</code></pre>");
});

test("mdToHtml: what is not Markdown stays as written, and nothing injects a tag", () => {
  assert.equal(mdToHtml("snake_case_name and 2*3*4"), "snake_case_name and 2*3*4");
  assert.equal(mdToHtml("<b>raw</b> & <script>"), "&lt;b&gt;raw&lt;/b&gt; &amp; &lt;script&gt;");
  assert.equal(mdToHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))");     // only http(s), tg, mailto links
  assert.equal(mdToHtml('[x](https://a.b/"onmouseover=1)'), '<a href="https://a.b/&quot;onmouseover=1">x</a>');
  assert.equal(mdToHtml("`**not bold**`"), "<code>**not bold**</code>");
});

test("htmlToPlain: the same card without tags", () => {
  assert.equal(htmlToPlain('<b>DONE</b> · <a href="https://x.y/1">PR</a> &lt;3 &amp;'), "DONE · PR (https://x.y/1) <3 &");
});

test("card: a long log folds away, a short one does not", () => {
  assert.match(card({ log: "one\ntwo" }), /\n<pre>one\ntwo<\/pre>$/);
  assert.match(card({ log: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") }), /<blockquote expandable><pre>[\s\S]*l29<\/pre><\/blockquote>$/);
});

test("sendCard: when Telegram rejects the HTML, the card still arrives as plain text", async () => {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const ok = !body.parse_mode;
    return { status: ok ? 200 : 400, json: async () => (ok ? { ok: true, result: {} } : { ok: false, description: "Bad Request: can't parse entities: Unmatched end tag" }) };
  };
  try {
    await sendCard("T", 1, { kind: "done", text: "**a *b** c*" });
  } finally { globalThis.fetch = real; }
  assert.equal(sent.length, 2);
  assert.equal(sent[0].parse_mode, "HTML");
  assert.equal(sent[1].parse_mode, undefined);
  assert.match(sent[1].text, /^🟢 DONE\n/);
  assert.doesNotMatch(sent[1].text, /</);
});

test("seldon tell never waits on a stdin nothing is piped into (an agent's shell)", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer, connect } = await import("node:net");
  const home = mkdtempSync(join(tmpdir(), "seldon-tell-"));
  writeFileSync(join(home, "telegram.json"), JSON.stringify({ id: 1 }));   // set up, so it gets as far as reading stdin
  // stdin = an open socket that never sends: exactly what an agent's shell hands its commands
  const server = createServer(() => {}).listen(0);
  await new Promise((r) => server.once("listening", r));
  const sock = connect(server.address().port);
  await new Promise((r) => sock.once("connect", r));
  try {
    const child = spawn(process.execPath, [BIN, "tell", "hi"], {
      env: { ...process.env, SELDON_HOME: home, SELDON_TELL_VIA_COMB: "1", TELEGRAM_BOT_TOKEN: "0:fake" }, stdio: [sock, "pipe", "pipe"] });
    const code = await Promise.race([new Promise((r) => child.on("exit", r)), new Promise((r) => setTimeout(() => r("hung"), 5000))]);
    if (code === "hung") child.kill();
    assert.notEqual(code, "hung");
  } finally { sock.destroy(); server.close(); rmSync(home, { recursive: true, force: true }); }
});
