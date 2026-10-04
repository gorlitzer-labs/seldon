// The files behind holds.mjs: ~/.seldon/holds/<resource>.json, one per held resource.
//
// Every read-decide-write runs inside a mutex (an atomic `mkdir`), so two agents asking at
// the same instant can never both win. A mutex left behind by a process that died inside the
// critical section — milliseconds long — is cleared after 10s.
import { mkdirSync, rmdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { decide, mayRelease, isLive, ownerPid } from "./holds.mjs";

const HOME = process.env.SELDON_HOME || join(homedir(), ".seldon");
export const HOLDS_DIR = join(HOME, "holds");

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const ps = (field, pid) => { try { return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
export const findOwner = () => ownerPid(process.ppid, (p) => Number(ps("ppid", p)) || null, (p) => ps("comm", p));

const file = (name) => join(HOLDS_DIR, `${name}.json`);
const read = (name) => { try { return JSON.parse(readFileSync(file(name), "utf8")); } catch { return null; } };

function withMutex(name, fn) {
  mkdirSync(HOLDS_DIR, { recursive: true });
  const m = join(HOLDS_DIR, `${name}.mutex`);
  for (let i = 0; ; i++) {
    try { mkdirSync(m); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(m).mtimeMs > 10_000) rmdirSync(m); } catch { /* raced */ }
      if (i > 500) throw new Error(`hold ${name}: could not get the lock file`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { try { rmdirSync(m); } catch { /* already gone */ } }
}

const write = (name, hold) => {
  const tmp = `${file(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hold, null, 2));
  renameSync(tmp, file(name));
};

// One attempt. { take } = it is ours now; { wait } = someone else has it.
export function tryHold(name, me, now = Date.now()) {
  return withMutex(name, () => {
    const r = decide(read(name), me, now, alive);
    if (r.take) write(name, { resource: name, ...r.take });
    return r;
  });
}

export function release(name, me, force = false, now = Date.now()) {
  return withMutex(name, () => {
    const r = mayRelease(read(name), me, now, alive, force);
    if (r.ok && !r.gone) rmSync(file(name), { force: true });
    return r;
  });
}

// Every hold in force right now (dead ones are left for the next taker to clear).
export function listHolds(now = Date.now()) {
  let names = [];
  try { names = readdirSync(HOLDS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; }
  return names.map(read).filter((h) => isLive(h, now, alive));
}
