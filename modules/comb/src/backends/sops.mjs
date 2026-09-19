/**
 * Storage: SOPS + age.
 *
 * Chosen for what it is NOT. A secrets server — Infisical, OpenBao — is a
 * database, a cache, a patch cadence and a thing that can be down at 3am when an
 * agent needs a key. This is two static binaries and an encrypted file. It runs
 * the same on a laptop and in a container, which matters because the container
 * is where the agents live now, and it means "self-hosted" is literally true:
 * nothing leaves the machine and there is no host to compromise.
 *
 * The file is safe to commit. That is the point — an encrypted store in a
 * private repo gets versioning and offsite backup for free, and the history
 * shows when each key last changed, which is the only rotation record anyone
 * actually keeps.
 *
 * The cost, stated plainly: the age private key is the one credential that
 * matters. Everything else is recoverable; that is not. It never goes in the
 * store, it never goes in the repo.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Where the encrypted store and the key live. Override for tests. */
export function combHome() {
  return process.env.COMB_HOME ?? join(homedir(), ".comb");
}
export const storePath = (home = combHome()) => join(home, "secrets.yaml");
export const keyPath = (home = combHome()) => join(home, "age.key");

function ageRecipient(home = combHome()) {
  const key = readFileSync(keyPath(home), "utf-8");
  const m = key.match(/public key: (age1[a-z0-9]+)/);
  if (!m) throw new Error("could not read the age public key — is ~/.comb/age.key intact?");
  return m[1];
}

/** True once there is a key and a store to talk to. */
export function initialised(home = combHome()) {
  return existsSync(keyPath(home)) && existsSync(storePath(home));
}

export function init(home = combHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath(home))) {
    const gen = spawnSync("age-keygen", { encoding: "utf-8" });
    if (gen.status !== 0) throw new Error("age-keygen failed — is `age` installed?");
    writeFileSync(keyPath(home), gen.stdout, { mode: 0o600 });
    chmodSync(keyPath(home), 0o600);
  }
  if (!existsSync(storePath(home))) {
    // An empty store still has to be encrypted, or the first `set` has nothing
    // to merge into and sops has no recipient to learn from.
    writeFileSync(storePath(home), "{}\n");
    const r = spawnSync("sops", ["--encrypt", "--age", ageRecipient(home), "--in-place", storePath(home)], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    if (r.status !== 0) throw new Error(`sops could not create the store: ${r.stderr?.trim()}`);
  }
  return { home, recipient: ageRecipient(home) };
}

function sopsEnv(home) {
  return { ...process.env, SOPS_AGE_KEY_FILE: keyPath(home) };
}

/** The whole store, decrypted in memory. Never written anywhere. */
export function readAll(home = combHome()) {
  if (!initialised(home)) throw new Error("no store yet — run `comb init`");
  const r = spawnSync("sops", ["--decrypt", "--output-type", "json", storePath(home)], {
    encoding: "utf-8",
    env: sopsEnv(home),
  });
  if (r.status !== 0) throw new Error(`could not decrypt the store: ${r.stderr?.trim()}`);
  return JSON.parse(r.stdout || "{}");
}

/**
 * Write one entry.
 *
 * `sops --set` rather than decrypt-edit-reencrypt: the plaintext store never
 * exists as a whole, not even for an instant, and not in a temp file.
 */
export function writeSecret(name, value, meta = {}, home = combHome()) {
  const entry = { value, updated: new Date().toISOString(), ...meta };
  // Subcommand form (`sops set <file> <index> <value>`), not the legacy --set
  // flag: `unset` only exists as a subcommand, and having the pair disagree is
  // how you end up with a delete that silently is not one.
  const r = spawnSync("sops", ["set", storePath(home), `["${name}"]`, JSON.stringify(entry)], {
    encoding: "utf-8",
    env: sopsEnv(home),
  });
  if (r.status !== 0) throw new Error(`could not write ${name}: ${r.stderr?.trim()}`);
}

export function deleteSecret(name, home = combHome()) {
  const r = spawnSync("sops", ["unset", storePath(home), `["${name}"]`], {
    encoding: "utf-8",
    env: sopsEnv(home),
  });
  if (r.status !== 0) throw new Error(`could not remove ${name}: ${r.stderr?.trim()}`);
}
