// Small shared helpers for reading the Foundation seam. Used by both the board's
// state gathering (hive.mjs) and the supervisor's tick (watch.mjs).
//   shOut    — run a command, keep its stdout even on a non-zero exit
//   readSafe — read a file that may not exist (missing → "")
//   count    — how many times a regex matches a string
//   openQueueItems — the unclaimed work at the top of docs/QUEUE.md
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const shOut = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { return (e.stdout || "").toString(); }
};
export const readSafe = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
export const count = (s, re) => (s.match(re) || []).length;

// The open items at the top of docs/QUEUE.md — what "what's next" means for a repo.
// `adopt` prints them, `hiveState` reports them, the board and seldon render them. One parser.
export function openQueueItems(dir, limit = 3) {
  const q = readSafe(join(dir, "docs", "QUEUE.md"));
  if (!q) return { total: 0, top: [] };
  const items = q.split("\n").filter((l) => /^- \[ \] /.test(l)).map((l) => l.replace(/^- \[ \] /, "").trim());
  return { total: items.length, top: items.slice(0, limit) };
}
