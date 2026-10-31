import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chunks, chatFromUpdates, mediaKind, fileFromMessage, inboxName, noteLine } from "../lib/telegram.mjs";

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
