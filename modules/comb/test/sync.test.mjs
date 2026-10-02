/**
 * comb sync — two machines, one vault, both ways.
 *
 * The merge rules are tested pure; the transport against real sops and age with
 * two separate homes, each with its own key, and a stand-in `ssh` that runs the
 * command against the other home and records everything that crossed "the
 * wire". The claims that matter: nothing is lost, a deletion travels, a change
 * on both sides is named, recipients are never changed, and the wire only ever
 * carries ciphertext.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as store from "../src/backends/sops.mjs";
import { addRealm, localRecipient } from "../src/realms.mjs";
import { mergeStores, recipientsOf, syncWith } from "../src/sync.mjs";

const v = (value, updated) => ({ value, updated });
const gone = (updated) => ({ deleted: true, updated });

describe("the merge rules", () => {
  test("a secret on one side only is copied to the other", () => {
    const { merged, report } = mergeStores({ A: v("a", "2026-01-01") }, { B: v("b", "2026-01-02") });
    assert.deepEqual(Object.keys(merged), ["A", "B"]);
    assert.deepEqual(report.pushed, ["A"]);
    assert.deepEqual(report.pulled, ["B"]);
  });

  test("on both sides, the newer wins — a rotation propagates", () => {
    const { merged } = mergeStores({ K: v("old", "2026-01-01") }, { K: v("new", "2026-02-01") });
    assert.equal(merged.K.value, "new");
  });

  test("a deletion beats an older value, so it is not resurrected", () => {
    const { merged } = mergeStores({ K: gone("2026-03-01") }, { K: v("still-here", "2026-01-01") });
    assert.equal(merged.K.deleted, true);
    assert.equal("value" in merged.K, false);
  });

  test("a newer value beats an older deletion — set again after removing", () => {
    const { merged } = mergeStores({ K: gone("2026-01-01") }, { K: v("back", "2026-02-01") });
    assert.equal(merged.K.value, "back");
  });

  test("an ordinary rotation on one side is not called a conflict", () => {
    const base = { K: "2026-01-01" };
    const { report } = mergeStores({ K: v("same", "2026-01-01") }, { K: v("rotated", "2026-02-01") }, base);
    assert.deepEqual(report.conflicts, []);
  });

  test("changed on both sides since the last sync is named, and the newer kept", () => {
    const base = { K: "2026-01-01" };
    const { merged, report } = mergeStores({ K: v("ours", "2026-02-01") }, { K: v("theirs", "2026-03-01") }, base);
    assert.equal(merged.K.value, "theirs");
    assert.deepEqual(report.conflicts, [{ name: "K", kept: "theirs" }]);
  });

  test("an exact tie is decided, not left to chance", () => {
    const a = mergeStores({ K: v("ours", "2026-01-01") }, { K: v("theirs", "2026-01-01") }).merged;
    const b = mergeStores({ K: v("ours", "2026-01-01") }, { K: v("theirs", "2026-01-01") }).merged;
    assert.deepEqual(a, b);
  });

  test("merging again changes nothing", () => {
    const { merged } = mergeStores({ A: v("a", "1"), K: gone("3") }, { B: v("b", "2"), K: v("k", "2") });
    assert.deepEqual(mergeStores(merged, merged).merged, merged);
  });
});

describe("syncing two real stores over ssh", () => {
  let here, there, bin, wire;
  const SECRET_HERE = "secret-set-on-this-machine-1234567890";
  const SECRET_THERE = "secret-set-on-the-other-machine-0987654321";

  before(() => {
    here = mkdtempSync(join(tmpdir(), "comb-sync-here-"));
    there = mkdtempSync(join(tmpdir(), "comb-sync-there-"));
    store.init(here); store.init(there);
    // Each machine registers the other as a realm: both stores readable by both.
    addRealm("there", localRecipient(there), here);
    addRealm("here", localRecipient(here), there);
    // The stand-in ssh: ignore the options and the host, run the command with
    // the other machine's home as ~, and log every byte sent in either direction.
    bin = mkdtempSync(join(tmpdir(), "comb-ssh-"));
    wire = join(bin, "wire.log");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh
for last; do :; done
cmd=$(printf '%s' "$last" | sed "s#~/.comb#${there}#g")
tee -a "${wire}" | sh -c "$cmd" | tee -a "${wire}"
`);
    chmodSync(join(bin, "ssh"), 0o755);
    process.env.COMB_SSH = join(bin, "ssh");
  });
  after(() => {
    delete process.env.COMB_SSH;
    for (const d of [here, there, bin]) rmSync(d, { recursive: true, force: true });
  });

  test("each side's new secret reaches the other", () => {
    store.writeSecret("FROM_HERE", SECRET_HERE, {}, here);
    store.writeSecret("FROM_THERE", SECRET_THERE, {}, there);
    const r = syncWith("peer", { home: here });
    assert.deepEqual(r.pushed, ["FROM_HERE"]);
    assert.deepEqual(r.pulled, ["FROM_THERE"]);
    assert.equal(store.readAll(here).FROM_THERE.value, SECRET_THERE);
    assert.equal(store.readAll(there).FROM_HERE.value, SECRET_HERE);
  });

  test("only ciphertext crossed the wire", () => {
    const sent = readFileSync(wire, "utf-8");
    assert.ok(sent.includes("ENC["), "the wire should have carried the encrypted store");
    assert.ok(!sent.includes(SECRET_HERE) && !sent.includes(SECRET_THERE), "a value crossed the wire in plaintext");
  });

  test("both sides end with the same file, still readable by both keys", () => {
    assert.equal(readFileSync(store.storePath(here), "utf-8"), readFileSync(store.storePath(there), "utf-8"));
    assert.equal(store.readAll(there).FROM_THERE.value, SECRET_THERE);
  });

  test("a second sync is a no-op and writes nothing", () => {
    const before = statSync(store.storePath(here)).mtimeMs;
    const r = syncWith("peer", { home: here });
    assert.equal(r.changedHere || r.changedThere, false);
    assert.equal(statSync(store.storePath(here)).mtimeMs, before);
  });

  test("a deletion on one side removes it on the other", () => {
    store.deleteSecret("FROM_HERE", there);
    syncWith("peer", { home: here });
    assert.equal("FROM_HERE" in store.readAll(here), false);
    assert.equal("FROM_HERE" in store.readAll(there), false);
  });

  test("the record of the last sync holds names and times, never values", () => {
    const base = readFileSync(join(here, "sync", "peer.json"), "utf-8");
    assert.ok(base.includes("FROM_THERE"));
    assert.ok(!base.includes(SECRET_THERE));
    assert.equal(statSync(join(here, "sync", "peer.json")).mode & 0o777, 0o600);
  });

  test("different recipients: refused, and nothing is written", () => {
    const stranger = mkdtempSync(join(tmpdir(), "comb-stranger-"));
    store.init(stranger);
    addRealm("stranger", localRecipient(stranger), there);   // only `there` adds it
    const before = readFileSync(store.storePath(here), "utf-8");
    assert.throws(() => syncWith("peer", { home: here }), /different recipients/);
    assert.equal(readFileSync(store.storePath(here), "utf-8"), before);
    assert.notDeepEqual(recipientsOf(before), recipientsOf(readFileSync(store.storePath(there), "utf-8")));
    rmSync(stranger, { recursive: true, force: true });
  });

  test("a host or path that could inject into ssh is refused", () => {
    assert.throws(() => syncWith("peer; rm -rf /", { home: here }), /not a host/);
    assert.throws(() => syncWith("peer", { home: here, remoteHome: "~/.comb; id" }), /not a path/);
  });
});

describe("deletion, on one machine", () => {
  let home;
  before(() => { home = mkdtempSync(join(tmpdir(), "comb-del-")); store.init(home); });
  after(() => rmSync(home, { recursive: true, force: true }));

  test("leaves a marker without the value, which readAll never shows", () => {
    store.writeSecret("TEMP", "value-that-must-be-erased-555", {}, home);
    store.deleteSecret("TEMP", home);
    assert.equal("TEMP" in store.readAll(home), false);
    assert.equal(store.readRaw(home).TEMP.deleted, true);
    assert.equal("value" in store.readRaw(home).TEMP, false);
  });

  test("removing what is not there is an error, not a silent marker", () => {
    assert.throws(() => store.deleteSecret("NEVER_SET", home), /no secret called/);
  });
});
