// comb across machines: give a realm agent the credentials it needs, without
// the secrets ever leaving your control.
//
// A secret encrypted with age can be encrypted to SEVERAL recipients at once —
// each with its own keypair, any one of which can decrypt. So each realm gets
// its own age key, the store is encrypted to all of them, and the SAME encrypted
// file can be copied to every realm (over bifrost's sync, or a private repo)
// leaking nothing: it is ciphertext, useless without a key.
//
// Revoking a realm is re-encrypting the store WITHOUT its key — no secret has to
// be rotated, because that realm can no longer decrypt anything, old copies
// included (its key never changes what the current ciphertext is encrypted to).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { combHome, storePath, keyPath } from "./backends/sops.mjs";

export const recipientsDir = (home = combHome()) => join(home, "recipients");

/** A realm's recipient file: just its age public key. */
const recipientFile = (name, home = combHome()) => join(recipientsDir(home), name);

/** The local store's own public key — always a recipient. */
export function localRecipient(home = combHome()) {
  const m = readFileSync(keyPath(home), "utf-8").match(/public key: (age1[a-z0-9]+)/);
  if (!m) throw new Error("no local age key — run `comb init`");
  return m[1];
}

/** Names of every realm registered as a recipient. */
export function listRealmRecipients(home = combHome()) {
  const d = recipientsDir(home);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => /^[A-Za-z0-9_-]+$/.test(n))
    .map((name) => ({ name, key: readFileSync(join(d, name), "utf-8").trim() }));
}

/** A public key is well-formed if it's a single age1… recipient. */
export function isValidAgePubkey(key) {
  return /^age1[a-z0-9]{20,}$/.test((key || "").trim());
}

/**
 * Re-key the store to exactly the current recipient set (local + all realms).
 *
 * Runs after any add or remove. `sops updatekeys`-style via rotate add/rm would
 * need diffing; instead we decrypt with our key and re-encrypt to the full set,
 * which is simplest and leaves the store readable by precisely those who should.
 */
export function rekeyStore(home = combHome()) {
  const recipients = [localRecipient(home), ...listRealmRecipients(home).map((r) => r.key)];
  const env = { ...process.env, SOPS_AGE_KEY_FILE: keyPath(home) };
  // Decrypt to JSON in memory, then re-encrypt to the new recipient set.
  const dec = spawnSync("sops", ["--decrypt", "--output-type", "json", storePath(home)], { encoding: "utf-8", env });
  if (dec.status !== 0) throw new Error(`could not decrypt to re-key: ${dec.stderr?.trim()}`);
  const enc = spawnSync("sops",
    ["--encrypt", "--age", recipients.join(","), "--input-type", "json", "--output-type", "yaml", "/dev/stdin"],
    { input: dec.stdout, encoding: "utf-8", env });
  if (enc.status !== 0) throw new Error(`could not re-encrypt: ${enc.stderr?.trim()}`);
  writeFileSync(storePath(home), enc.stdout);
  return recipients.length;
}

/** Register a realm's public key and re-key the store so it can read secrets. */
export function addRealm(name, pubkey, home = combHome()) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid realm name: ${JSON.stringify(name)}`);
  const key = (pubkey || "").trim();
  if (!isValidAgePubkey(key)) throw new Error("that is not an age public key (expected age1…)");
  mkdirSync(recipientsDir(home), { recursive: true });
  writeFileSync(recipientFile(name, home), key + "\n", { mode: 0o644 });
  return rekeyStore(home);
}

/** Remove a realm and re-key WITHOUT it — revocation. */
export function removeRealm(name, home = combHome()) {
  const f = recipientFile(name, home);
  if (!existsSync(f)) throw new Error(`no realm recipient called ${name}`);
  rmSync(f);
  return rekeyStore(home);
}
