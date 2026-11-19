// Claude Code's folder trust, for lanes seldon starts with `claude --bg`.
//
// `claude --bg` refuses a folder Claude has never been trusted in ("Workspace not trusted. Run
// `claude` … once and accept the trust prompt"), and no flag skips that. The acceptance lives in
// ~/.claude.json under projects[<dir>].hasTrustDialogAccepted, keyed by the exact
// folder. apiary records it the same way (modules/apiary/src/cli/claude/trust.ts) for the
// agents it launches; `seldon lane start` never goes through apiary, so it records it here.
//
// Recording it is the user's own assertion, made by naming the folder: the folder `seldon new`
// just made, or the one a person passed to `seldon lane start`. The steward is not a person, so it
// may only start lanes where trust already exists (see trustPlan). Nothing else in the file is
// touched, and the write is atomic so a crash cannot truncate a config holding every project.
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const claudeConfigPath = (home = homedir()) => join(home, ".claude.json");

const readConfig = (path) => {
  if (!existsSync(path)) return { missing: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? { parsed } : { bad: true };
  } catch { return { bad: true }; }
};

// Is `dir` itself trusted? Only the folder's own entry counts: `claude --bg` refused
// ~/Desktop/pipelines-test with ~/Desktop trusted (checked 2026-11-19), so a parent does not.
export function isTrusted(dir, { configPath = claudeConfigPath() } = {}) {
  const projects = readConfig(configPath).parsed?.projects;
  return !!projects && typeof projects === "object" && projects[resolve(dir)]?.hasTrustDialogAccepted === true;
}

// Record trust for `dir`. Never throws: "already-trusted" | "trusted" | "no-config" | "failed".
export function recordTrust(dir, { configPath = claudeConfigPath() } = {}) {
  const key = resolve(dir);
  if (isTrusted(key, { configPath })) return "already-trusted";
  const { parsed, missing } = readConfig(configPath);
  if (missing) return "no-config";
  if (!parsed) return "failed";          // malformed: losing it is worse than one prompt
  const projects = parsed.projects ?? {};
  if (typeof projects !== "object" || projects === null) return "failed";
  projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true };
  parsed.projects = projects;
  const tmp = `${configPath}.seldon-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmp, configPath);
    return "trusted";
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return "failed";
  }
}

// What to do about trust before `claude --bg` in `dir`.
//   mayRecord: a person named the folder, or seldon just made it. False for the steward on a
//   folder it did not make: it gets a clear "ask Franco" instead of a write.
// Returns { ok: true, note? } or { ok: false, error }.
export function trustPlan(dir, { mayRecord, configPath = claudeConfigPath() }) {
  if (isTrusted(dir, { configPath })) return { ok: true };
  const run = `run \`claude\` in ${dir} once and accept the trust prompt`;
  if (!mayRecord) return { ok: false, error: `Claude has not been trusted in ${dir} yet, and the steward does not grant trust. Ask Franco to ${run}, or to start it himself with seldon lane start.` };
  const r = recordTrust(dir, { configPath });
  if (r === "trusted") return { ok: true, note: `trusted ${dir} for Claude (recorded in ~/.claude.json)` };
  if (r === "already-trusted") return { ok: true };
  if (r === "no-config") return { ok: false, error: `Claude has never run on this machine (no ~/.claude.json): ${run}, then retry.` };
  return { ok: false, error: `could not record Claude's trust for ${dir} (~/.claude.json unreadable or not writable): ${run}, then retry.` };
}
