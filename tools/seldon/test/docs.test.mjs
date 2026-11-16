import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOPICS, searchDocs } from "../lib/docs.mjs";
import { KEYS } from "../lib/workspace.mjs";

test("search: empty lists everything; every word must match; title beats tag beats text", () => {
  assert.equal(searchDocs("").length, TOPICS.length);
  assert.equal(searchDocs("phone")[0].id, "phone");
  assert.equal(searchDocs("TELEGRAM")[0].id, "telegram");             // case does not matter
  assert.equal(searchDocs("resume")[0].id, "stop");                   // a tag finds it
  assert.deepEqual(searchDocs("phone zzzz"), []);                     // all words, not any
});

test("short on purpose: a topic is at most 3 lines and 3 examples, every line under 80", () => {
  for (const t of TOPICS) {
    assert.ok(t.what.length <= 3 && t.examples.length >= 1 && t.examples.length <= 3, t.id);
    for (const l of t.what) assert.ok(l.length <= 76, `${t.id}: ${l}`);
  }
});

test("no example points at a command that does not exist", () => {
  const bin = readFileSync(new URL("../bin/seldon.js", import.meta.url), "utf8");
  const commands = new Set([...bin.matchAll(/cmd === "([a-z-]+)"/g)].map((m) => m[1]));
  for (const t of TOPICS) for (const [ex] of t.examples) {
    const m = ex.match(/^seldon ([a-z-]+)/);
    if (m) assert.ok(commands.has(m[1]), `${t.id}: seldon ${m[1]} is a real command`);
  }
});

test("every key the docs mention is a key the workspace really has", () => {
  const keys = new Set(KEYS.flatMap(([, ks]) => ks.map(([k]) => k)));
  const said = TOPICS.find((t) => t.id === "keys").what.join(" ").match(/⌥[a-z0-9←→-]+/g);
  for (const k of said) assert.ok(keys.has(k) || keys.has(k.replace(/-\d$/, "-9")), `${k} is on the keys card`);
});
