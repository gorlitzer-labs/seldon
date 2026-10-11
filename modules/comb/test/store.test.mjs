/**
 * The store's contract: encrypted at rest, and never plaintext on disk.
 *
 * These run against real sops and age rather than a mock. A mock would prove
 * that the code calls encrypt; only the real thing proves the file that lands on
 * disk cannot be read, which is the entire claim.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as store from "../src/backends/sops.mjs";

const SECRET = "token-value-that-must-never-be-readable-0123456789";
let home;

before(() => { home = mkdtempSync(join(tmpdir(), "comb-store-")); store.init(home); });
after(() => rmSync(home, { recursive: true, force: true }));

describe("at rest", () => {
  test("the value is not readable in the file on disk", () => {
    store.writeSecret("CF_API_TOKEN", SECRET, {}, home);
    const onDisk = readFileSync(store.storePath(home), "utf-8");
    assert.ok(!onDisk.includes(SECRET), "the secret must not be plaintext in the store");
    assert.ok(onDisk.includes("ENC["), "the store must actually be encrypted");
  });

  test("the private key is not world-readable", () => {
    const mode = statSync(store.keyPath(home)).mode & 0o777;
    assert.equal(mode, 0o600, "the age key is the one credential that cannot be recovered");
  });
});

describe("round trip", () => {
  test("what goes in comes back out", () => {
    store.writeSecret("A_KEY", SECRET, {}, home);
    assert.equal(store.readAll(home).A_KEY.value, SECRET);
  });

  test("an update replaces the old value entirely — rotation must not leave the old one behind", () => {
    store.writeSecret("ROTATED", "old-value-aaaaaaaaaaaaaaaaaaaaaaa", {}, home);
    store.writeSecret("ROTATED", "new-value-bbbbbbbbbbbbbbbbbbbbbbb", {}, home);
    assert.equal(store.readAll(home).ROTATED.value, "new-value-bbbbbbbbbbbbbbbbbbbbbbb");
    const onDisk = readFileSync(store.storePath(home), "utf-8");
    assert.ok(!onDisk.includes("old-value"), "the superseded value must be gone, not merely shadowed");
  });

  test("stamps when it changed, which is the only rotation record anyone keeps", () => {
    store.writeSecret("STAMPED", SECRET, {}, home);
    assert.match(store.readAll(home).STAMPED.updated, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("removal takes it out of the store", () => {
    store.writeSecret("TEMP", SECRET, {}, home);
    store.deleteSecret("TEMP", home);
    assert.equal("TEMP" in store.readAll(home), false);
  });
});
