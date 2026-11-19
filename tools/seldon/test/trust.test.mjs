import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTrusted, recordTrust, trustPlan } from "../lib/trust.mjs";

const cfg = (projects) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
  const p = path.join(dir, ".claude.json");
  if (projects !== undefined) fs.writeFileSync(p, typeof projects === "string" ? projects : JSON.stringify({ numStartups: 3, projects }));
  return p;
};
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("a trusted parent folder does not count: claude --bg checks the folder itself", () => {
  const p = cfg({ "/u/Desktop": { hasTrustDialogAccepted: true } });
  assert.equal(isTrusted("/u/Desktop", { configPath: p }), true);
  assert.equal(isTrusted("/u/Desktop/new-thing", { configPath: p }), false);
  assert.equal(recordTrust("/u/Desktop/new-thing", { configPath: p }), "trusted");
});

test("recording trust keeps everything else in the file", () => {
  const p = cfg({ "/u/a": { allowedTools: ["x"], hasTrustDialogAccepted: false } });
  assert.equal(recordTrust("/u/a", { configPath: p }), "trusted");
  const c = read(p);
  assert.equal(c.numStartups, 3);
  assert.deepEqual(c.projects["/u/a"], { allowedTools: ["x"], hasTrustDialogAccepted: true });
  assert.equal(recordTrust("/u/a", { configPath: p }), "already-trusted");
});

test("a malformed or missing config is never rewritten", () => {
  const bad = cfg("{nope");
  assert.equal(recordTrust("/u/a", { configPath: bad }), "failed");
  assert.equal(fs.readFileSync(bad, "utf8"), "{nope");
  assert.equal(recordTrust("/u/a", { configPath: cfg() }), "no-config");
});

test("a person (or seldon new) gets the folder trusted; the steward gets a clear refusal and no write", () => {
  const p = cfg({});
  const steward = trustPlan("/u/pipelines-test", { mayRecord: false, configPath: p });
  assert.equal(steward.ok, false);
  assert.match(steward.error, /Ask Franco/);
  assert.deepEqual(read(p).projects, {}, "the steward wrote nothing");
  const person = trustPlan("/u/pipelines-test", { mayRecord: true, configPath: p });
  assert.equal(person.ok, true);
  assert.match(person.note, /trusted/);
  assert.equal(read(p).projects["/u/pipelines-test"].hasTrustDialogAccepted, true);
  assert.deepEqual(trustPlan("/u/pipelines-test", { mayRecord: false, configPath: p }), { ok: true }, "once trusted, the steward may start it");
});

test("no config says what to do instead of failing inside claude", () => {
  const r = trustPlan("/u/x", { mayRecord: true, configPath: cfg() });
  assert.equal(r.ok, false);
  assert.match(r.error, /run `claude` in \/u\/x once/);
});
