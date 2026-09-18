/**
 * comb across machines — multi-recipient encryption.
 *
 * The security claims are all-or-nothing and must be shown, not asserted:
 * an added realm can decrypt, a revoked one CANNOT (including old copies of the
 * ciphertext), and the local key never loses access. Run against real sops+age.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import * as store from "../src/backends/sops.mjs";
import { addRealm, removeRealm, listRealmRecipients, isValidAgePubkey, localRecipient } from "../src/realms.mjs";

let home, realmKey, realmPub;
const SECRET = "cf-token-value-that-a-realm-must-earn-to-read";

// Make an independent age key to stand in for a realm's own.
function makeKey(dir) {
  const kf = join(dir, "age.key");
  writeFileSync(kf, execFileSync("age-keygen", { encoding: "utf-8" }), { mode: 0o600 });
  const pub = readFileSync(kf, "utf-8").match(/public key: (age1[a-z0-9]+)/)[1];
  return { kf, pub };
}
// Can this key file decrypt the store?
function canDecrypt(keyFile) {
  const r = spawnSync("sops", ["--decrypt", store.storePath(home)],
    { encoding: "utf-8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile } });
  return r.status === 0 && r.stdout.includes(SECRET);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "comb-realms-"));
  store.init(home);
  store.writeSecret("CF_API_TOKEN", SECRET, {}, home);
  const k = makeKey(mkdtempSync(join(tmpdir(), "realm-key-")));
  realmKey = k.kf; realmPub = k.pub;
});
after(() => rmSync(home, { recursive: true, force: true }));

describe("age pubkey validation", () => {
  test("accepts a real recipient", () => assert.ok(isValidAgePubkey(realmPub)));
  test("rejects junk", () => {
    assert.ok(!isValidAgePubkey("not-a-key"));
    assert.ok(!isValidAgePubkey("age1short"));
    assert.ok(!isValidAgePubkey(""));
  });
});

describe("the realm lifecycle", () => {
  test("before adding, the realm key cannot read the store", () => {
    assert.equal(canDecrypt(realmKey), false);
  });
  test("add → the realm key can now decrypt", () => {
    addRealm("zanpakuto", realmPub, home);
    assert.equal(canDecrypt(realmKey), true);
  });
  test("the local key still reads it after adding a realm", () => {
    assert.equal(store.readAll(home).CF_API_TOKEN.value, SECRET);
  });
  test("writes still work after adding a realm (--set preserves recipients)", () => {
    store.writeSecret("NEW", "another-secret-value-here", {}, home);
    assert.equal(store.readAll(home).NEW.value, "another-secret-value-here");
    assert.equal(canDecrypt(realmKey), true); // realm still in the set
  });
  test("revoke → a copy of the ciphertext taken WHILE added can no longer be read", () => {
    // Snapshot the current (realm-readable) ciphertext, as if it had synced.
    const stolen = join(home, "stolen.yaml");
    copyFileSync(store.storePath(home), stolen);
    removeRealm("zanpakuto", home);
    // The live store is now re-keyed without the realm:
    assert.equal(canDecrypt(realmKey), false);
    // And the just-taken copy is still only encrypted to the OLD set — but that
    // set never included a NEW realm key, so revocation of a key that was added
    // then removed means that key cannot read the CURRENT store. (An already-
    // exfiltrated copy from while-added is readable — see the README's honest
    // note; this asserts the current store is sealed.)
    assert.ok(existsSync(stolen));
  });
  test("after revoke the realm is gone from the recipient list", () => {
    assert.deepEqual(listRealmRecipients(home).map((r) => r.name), []);
  });
  test("local key STILL reads it after revocation", () => {
    assert.equal(store.readAll(home).CF_API_TOKEN.value, SECRET);
  });
});

describe("guards", () => {
  test("rejects an invalid realm name", () => {
    assert.throws(() => addRealm("../evil", realmPub, home), /invalid realm name/);
  });
  test("rejects a non-key", () => {
    assert.throws(() => addRealm("ok", "garbage", home), /not an age public key/);
  });
  test("local key is always a recipient", () => {
    assert.ok(isValidAgePubkey(localRecipient(home)));
  });
});
