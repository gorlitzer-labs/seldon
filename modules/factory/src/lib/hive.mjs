// Shared hive registry + state gathering (used by the board; the supervisor reads state inline).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { shOut, readSafe, count } from "./util.mjs";

const REG = join(homedir(), ".factory", "hives.json");

export function readRegistry() {
  try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return []; }
}
// A hive is live only while its folder is still a git repo — `new` and `adopt` both guarantee
// one. Folder-exists is not enough: `watch` writes .factory/digest.log into every registered
// dir, so it kept re-creating the folders of deleted projects and they never looked dead.
export const isLiveHive = (e) => !!e?.dir && existsSync(join(e.dir, ".git"));

// Drop entries that are no longer live (renamed, deleted, scratch dirs). Returns their names.
export function pruneRegistry() {
  const all = readRegistry();
  const keep = all.filter(isLiveHive);
  if (keep.length === all.length) return [];
  writeFileSync(REG, JSON.stringify(keep, null, 2));
  return all.filter((e) => !keep.includes(e)).map((e) => e.name);
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
