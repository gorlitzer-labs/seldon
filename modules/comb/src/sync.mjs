/**
 * comb sync — one vault on two machines, kept the same both ways.
 *
 * A realm can read the store, but each machine still holds its own copy, and a
 * secret set on one used to stay there until somebody copied the file across —
 * which also threw away whatever the other side had added. This merges the two.
 *
 * What crosses the wire is ciphertext only. The other side's store is fetched
 * over ssh (`cat`), decrypted HERE with this machine's key (both are recipients
 * of the same store), merged, re-encrypted to the same recipients, and the one
 * resulting file is written to both sides. The other machine needs nothing but
 * ssh: no comb, no sops, no key in use.
 *
 * The merge, secret by secret:
 *   - on one side only          → copied to the other
 *   - on both, different        → the newer `updated` wins
 *   - a deletion marker         → wins over an older value, loses to a newer one
 * Without a record of the last sync, "different" cannot tell an ordinary
 * rotation from a secret changed on BOTH sides since. So each sync leaves the
 * timestamps it agreed on (names and times, never values) in sync/<peer>.json;
 * the next one compares against it and names anything changed on both sides.
 * The newer still wins — but you are told which one was overwritten.
 *
 * It refuses, and writes nothing, when the two stores are not encrypted to the
 * same recipients: a sync must never be the way a realm is added or revoked.
 * And it re-reads the other side just before writing, so a change made there
 * mid-sync is not overwritten.
 *
 * Not a ledger, on purpose. A ledger keeps every old value; for secrets the
 * point of rotating is that the old value is gone.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { combHome, storePath, keyPath, readRaw } from "./backends/sops.mjs";
import { localRecipient } from "./realms.mjs";

const SAFE_PEER = /^[A-Za-z0-9_.@-]+$/;
const SAFE_PATH = /^[~A-Za-z0-9_./-]+$/;

/** The age recipients a store is encrypted to, read from its sops metadata. */
export function recipientsOf(ciphertext) {
  return [...new Set([...(ciphertext || "").matchAll(/recipient:\s*(age1[a-z0-9]+)/g)].map((m) => m[1]))].sort();
}

// Equal as data, whatever order the keys are in. A byte comparison of the JSON
// minds order, and the merge sorts by name — so two identical stores used to
// look changed and both files were rewritten on every sync.
const canonical = (x) => Array.isArray(x) ? x.map(canonical)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const stamp = (e) => e?.updated ?? "";

/**
 * Merge two decrypted stores. Pure: no I/O, so every rule is testable alone.
 *
 * `base` is the name → updated map the previous sync agreed on (may be empty).
 * Returns the merged store and, by name only, what moved and what collided.
 */
export function mergeStores(local, remote, base = {}) {
  const merged = {};
  const report = { pulled: [], pushed: [], conflicts: [] };
  const names = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
  for (const n of names) {
    const a = local[n], b = remote[n];
    if (b === undefined) { merged[n] = a; report.pushed.push(n); continue; }
    if (a === undefined) { merged[n] = b; report.pulled.push(n); continue; }
    if (same(a, b)) { merged[n] = a; continue; }
    // Newer wins; on an exact tie keep this side's, so the result is decided.
    const remoteWins = stamp(b) > stamp(a);
    merged[n] = remoteWins ? b : a;
    (remoteWins ? report.pulled : report.pushed).push(n);
    // Changed on both sides since the last agreed state: say so.
    if (n in base && stamp(a) !== base[n] && stamp(b) !== base[n]) {
      report.conflicts.push({ name: n, kept: remoteWins ? "theirs" : "ours" });
    }
  }
  return { merged, report };
}

function ssh(peer, command, input) {
  const bin = process.env.COMB_SSH || "ssh";   // overridable for tests
  return spawnSync(bin, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", peer, command],
    { encoding: "utf-8", input, maxBuffer: 64 * 1024 * 1024 });
}

function fetch(peer, remoteHome) {
  const r = ssh(peer, `cat ${remoteHome}/secrets.yaml`);
  if (r.status !== 0) throw new Error(`could not read ${peer}:${remoteHome}/secrets.yaml — ${r.stderr?.trim() || "ssh failed"}`);
  return r.stdout;
}

function decrypt(ciphertext, home) {
  const dir = mkdtempSync(join(tmpdir(), "comb-sync-"));
  try {
    // Ciphertext only: it is safe on disk, and sops wants a file to read.
    const f = join(dir, "peer.yaml");
    writeFileSync(f, ciphertext, { mode: 0o600 });
    const r = spawnSync("sops", ["--decrypt", "--output-type", "json", f],
      { encoding: "utf-8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath(home) } });
    if (r.status !== 0) throw new Error(`could not decrypt the other side's store with this machine's key: ${r.stderr?.trim()}`);
    return JSON.parse(r.stdout || "{}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function encrypt(plain, recipients, home) {
  // Same as realms.rekeyStore: sops reads a private temp file, never /dev/stdin
  // (not openable in some non-interactive contexts), and it is wiped at once.
  const dir = mkdtempSync(join(tmpdir(), "comb-sync-"));
  try {
    const f = join(dir, "store.json");
    writeFileSync(f, JSON.stringify(plain), { mode: 0o600 });
    const r = spawnSync("sops",
      ["--encrypt", "--age", recipients.join(","), "--input-type", "json", "--output-type", "yaml", f],
      { encoding: "utf-8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath(home) } });
    if (r.status !== 0) throw new Error(`could not encrypt the merged store: ${r.stderr?.trim()}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const basePath = (peer, home) => join(home, "sync", `${peer}.json`);
const readBase = (peer, home) => existsSync(basePath(peer, home)) ? JSON.parse(readFileSync(basePath(peer, home), "utf-8")) : {};
function writeBase(peer, store, home) {
  mkdirSync(join(home, "sync"), { recursive: true, mode: 0o700 });
  // Names and timestamps only — never a value.
  const stamps = Object.fromEntries(Object.entries(store).map(([n, e]) => [n, stamp(e)]));
  writeFileSync(basePath(peer, home), JSON.stringify(stamps, null, 1) + "\n", { mode: 0o600 });
}

/** Sync this machine's store with `peer` (an ssh destination). */
export function syncWith(peer, { remoteHome = "~/.comb", home = combHome() } = {}) {
  if (!SAFE_PEER.test(peer)) throw new Error(`not a host comb will pass to ssh: ${JSON.stringify(peer)}`);
  if (!SAFE_PATH.test(remoteHome)) throw new Error(`not a path comb will pass to ssh: ${JSON.stringify(remoteHome)}`);

  const theirsCipher = fetch(peer, remoteHome);
  const oursCipher = readFileSync(storePath(home), "utf-8");
  const ours = recipientsOf(oursCipher), theirs = recipientsOf(theirsCipher);
  if (!ours.includes(localRecipient(home))) throw new Error("this machine's key is not a recipient of its own store — run `comb init`?");
  if (!same(ours, theirs)) {
    throw new Error(`the two stores are encrypted to different recipients (here ${ours.length}, ${peer} ${theirs.length}). ` +
      "Add or revoke realms on both sides first — sync never changes who can read the store.");
  }

  const local = readRaw(home), remote = decrypt(theirsCipher, home);
  const { merged, report } = mergeStores(local, remote, readBase(peer, home));
  const changedHere = !same(merged, local), changedThere = !same(merged, remote);

  if (changedHere || changedThere) {
    const out = encrypt(merged, ours, home);
    if (changedThere) {
      if (fetch(peer, remoteHome) !== theirsCipher) throw new Error(`${peer} changed its store during the sync — nothing was written; run it again`);
      const tmp = `${remoteHome}/secrets.yaml.comb-sync`;
      const w = ssh(peer, `umask 077 && cat > ${tmp} && mv ${tmp} ${remoteHome}/secrets.yaml`, out);
      if (w.status !== 0) throw new Error(`could not write ${peer}'s store — nothing changed here: ${w.stderr?.trim()}`);
    }
    if (changedHere) writeFileSync(storePath(home), out);
  }
  writeBase(peer, merged, home);
  const live = Object.values(merged).filter((e) => !e?.deleted).length;
  return { ...report, changedHere, changedThere, live };
}
