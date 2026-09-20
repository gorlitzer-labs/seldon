// Small shared helpers for reading the Foundation seam. Used by both the board's
// state gathering (hive.mjs) and the supervisor's tick (watch.mjs).
//   shOut    — run a command, keep its stdout even on a non-zero exit
//   readSafe — read a file that may not exist (missing → "")
//   count    — how many times a regex matches a string
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const shOut = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { return (e.stdout || "").toString(); }
};
export const readSafe = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
export const count = (s, re) => (s.match(re) || []).length;
