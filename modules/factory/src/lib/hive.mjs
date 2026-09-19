// Shared hive registry + state gathering (used by the board; the supervisor reads state inline).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REG = join(homedir(), ".factory", "hives.json");
const shOut = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return (e.stdout || "").toString(); } };
const readSafe = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const count = (s, re) => (s.match(re) || []).length;

export function readRegistry() {
  try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return []; }
}
export function addToRegistry(entry) {
  const all = readRegistry().filter((e) => e.dir !== entry.dir);
  all.push({ name: entry.name, dir: entry.dir, hive: entry.hive, added: entry.added || null });
  mkdirSync(join(homedir(), ".factory"), { recursive: true });
  writeFileSync(REG, JSON.stringify(all, null, 2));
}

// Parse the 6-col WORKSTREAMS table into lane objects.
export function lanesOf(dir) {
  const text = readSafe(join(dir, "docs", "WORKSTREAMS.md"));
  return text.split("\n")
    .filter((l) => /^\|\s/.test(l) && !/stream\s*\|/i.test(l) && !/^\|\s*-/.test(l))
    .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()))
    .filter((c) => c.length === 6)
    .map((c) => ({ stream: c[0], owner: c[1], status: c[3], blocker: c[4] }));
}

// Gather a hive's live state — seam-driven (no room join), reachability best-effort.
export async function hiveState(entry) {
  const { name, dir, hive } = entry;
  const doctor = shOut("foundation", ["doctor", "--dir", dir]);
  const drift = doctor.includes("no drift") ? 0 : parseInt(doctor.match(/(\d+) drift issue/)?.[1] || "0", 10);
  const lanes = lanesOf(dir);
  const q = readSafe(join(dir, "docs", "QUEUE.md"));
  const s = {
    name, dir,
    up: false,
    queueOpen: count(q, /^- \[ \] /gm),
    done: count(readSafe(join(dir, "docs", "DONE.md")), /^- \[x\] /gm),
    facts: count(readSafe(join(dir, "docs", "FACTS.md")), /^- `/gm),
    lanes, drift,
    blockers: lanes.filter((l) => l.blocker && l.blocker !== "-").length,
    digest: lastDigest(dir),
  };
  if (hive?.serverUrl) {
    try { await fetch(hive.serverUrl + "/", { signal: AbortSignal.timeout(1500) }); s.up = true; } catch { s.up = false; }
  }
  return s;
}

function lastDigest(dir) {
  const p = join(dir, ".factory", "digest.log");
  if (!existsSync(p)) return null;
  const lines = readSafe(p).trim().split("\n").filter((l) => l.startsWith("["));
  return lines.length ? lines[lines.length - 1] : null;
}
