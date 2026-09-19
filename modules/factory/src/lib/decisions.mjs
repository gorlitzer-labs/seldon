// The pending-decisions queue — the things needing the human's call, surfaced from the hives.
// Agents escalate with a `DECISION:` (or `BLOCKER:`) message; the supervisor files it here; the
// human answers with `factory decide`. Supervised autonomy's core loop.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE = join(homedir(), ".factory", "decisions.json");
const idOf = (hive, text) => "d-" + createHash("sha1").update(hive + "|" + text).digest("hex").slice(0, 6);

export function readDecisions() {
  try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return []; }
}
function write(arr) {
  mkdirSync(join(homedir(), ".factory"), { recursive: true });
  writeFileSync(STORE, JSON.stringify(arr, null, 2));
}

// File a decision if new. Returns the entry if newly added, else null (dedup by hive+text).
export function fileDecision({ hive, dir, from, text, kind, ts }) {
  const id = idOf(hive, text);
  const all = readDecisions();
  if (all.some((d) => d.id === id)) return null;
  const entry = { id, hive, dir, from, text, kind: kind || "decision", ts: ts || "", status: "pending" };
  all.push(entry); write(all);
  return entry;
}

export const pending = () => readDecisions().filter((d) => d.status === "pending");

// Resolve one by id; returns the resolved entry (with the answer) or null if not found.
export function resolveDecision(id, answer) {
  const all = readDecisions();
  const d = all.find((x) => x.id === id && x.status === "pending");
  if (!d) return null;
  d.status = "answered"; d.answer = answer; d.answeredAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  write(all);
  return d;
}
