// Other machines. bifrost already owns "which machines exist" (~/.config/bifrost/realms/<name>,
// REALM_HOST / REALM_USER), so seldon reads that rather than keeping a second list; factory
// does the same (modules/factory/src/lib/realm.mjs). `seldon machines add` writes the same
// format, so the two tools always agree.
//
// The protocol is just seldon on the other end: `ssh <machine> seldon lanes --json` to read,
// `seldon lane <verb> <key>` to act. Pure helpers first, then the I/O.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { groupByProject } from "./lanes.mjs";

export const REALMS_DIR = join(homedir(), ".config", "bifrost", "realms");

// Read narrowly — two keys, quotes stripped, nothing executed. Sourcing a file to learn a
// hostname is not something to do.
export function parseRealmFile(text) {
  const pick = (key) => {
    for (const k of [`REALM_${key}`, `DEVICE_${key}`]) {
      const m = String(text).match(new RegExp(`^\\s*${k}=["']?([^"'\\n]+)`, "m"));
      if (m) return m[1].trim();
    }
    return null;
  };
  const host = pick("HOST");
  return host ? { host, user: pick("USER") } : null;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ssh argv that runs `argv` on the machine through its login shell — a non-interactive ssh
// often has no PATH to seldon (npm/pnpm/nvm set it in the shell's rc files).
export function sshArgs(machine, argv, { tty = false } = {}) {
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const inner = argv.map(sq).join(" ");
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", ...(tty ? ["-t"] : []), target, `exec "$SHELL" -lic ${sq(inner)}`];
}

// The JSON line in a remote reply. rc files can print before it (a motd, nvm notices).
export function lastJsonLine(text) {
  const line = String(text).split("\n").reverse().find((l) => l.trim().startsWith("["));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

// A machine's lanes as project groups, named and keyed so they can never collide with this
// machine's: "stranded @mini", key "mini/claude:ab12".
export function remoteGroups(machine, lanes) {
  const tagged = (lanes || []).map((l) => ({ ...l, machine: machine.name, remoteKey: l.key, key: `${machine.name}/${l.key}` }));
  const projectOf = new Map(tagged.map((l) => [l.cwd, l.project]));     // the remote already resolved it
  return groupByProject(tagged, (cwd) => projectOf.get(cwd)).map((g) => ({
    ...g,
    root: `${machine.name}:${g.root}`,      // unique across machines
    remoteRoot: g.root,                      // the path on that machine
    name: `${g.lanes[0].projectName || g.name} @${machine.name}`,
    machine: machine.name,
  }));
}

// ---- I/O -------------------------------------------------------------------------
export function listMachines() {
  let names = [];
  try { names = readdirSync(REALMS_DIR); } catch { return []; }
  return names.map((name) => {
    try { const r = parseRealmFile(readFileSync(join(REALMS_DIR, name), "utf8")); return r ? { name, ...r } : null; } catch { return null; }
  }).filter(Boolean);
}

export function addMachine(name, target) {
  const [user, host] = target.includes("@") ? target.split("@") : [null, target];
  mkdirSync(REALMS_DIR, { recursive: true });
  writeFileSync(join(REALMS_DIR, name), `REALM_HOST="${host}"\n${user ? `REALM_USER="${user}"\n` : ""}`);
  return { name, host, user };
}

// Ask a machine for its lanes, in the background. Never throws; `error` says why it failed.
export function fetchLanes(machine, cb) {
  execFile("ssh", sshArgs(machine, ["seldon", "lanes", "--json"]), { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
    const lanes = lastJsonLine(stdout);
    cb(lanes ? { lanes } : { error: err ? (err.killed ? "timed out" : "unreachable") : "no seldon there" });
  });
}
