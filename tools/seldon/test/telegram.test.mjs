import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chunks, chatFromUpdates, mediaKind } from "../lib/telegram.mjs";

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
  const env = { ...process.env, SELDON_TELL_VIA_COMB: "1" };
  delete env.TELEGRAM_BOT_TOKEN;
  const r = spawnSync(process.execPath, [BIN, "tell", "hi"], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /comb set TELEGRAM_BOT_TOKEN/);
});

test("mediaKind: each file shows up the way it should", () => {
  assert.equal(mediaKind("shot.PNG").method, "sendPhoto");
  assert.equal(mediaKind("/out/pitch.mp4").method, "sendVideo");
  assert.equal(mediaKind("demo.gif").method, "sendAnimation");
  assert.equal(mediaKind("vo.mp3").method, "sendAudio");
  assert.equal(mediaKind("report.pdf").method, "sendDocument");
  assert.equal(mediaKind("Makefile").method, "sendDocument");
});
