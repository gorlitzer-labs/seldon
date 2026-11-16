// "Where am I, and what is missing?" — asked once, used by `seldon go` and the panel.
//
// This owns NO state. factory owns the hive registry, foundation owns the docs seam, apiary
// owns the rooms. Everything here either reads `factory state --compact` or delegates to a
// sibling CLI. The moment seldon starts parsing docs/QUEUE.md itself there are two parsers of
// the seam and they drift — which is the mistake factory's own state.mjs header warns about.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ---- sibling CLIs -----------------------------------------------------------
// seldon, factory, apiary and comb install side by side, but the install dir (pnpm's global
// bin) is often absent from PATH in a NON-interactive shell — a script, a hook, an agent's
// Bash tool. seldon itself was found, so its own directory is the one place guaranteed to
// hold its siblings. Prepending it turns "factory: command not found" into a non-event.
export function ensureSiblingPath(argv1 = process.argv[1]) {
  try {
    const dir = path.dirname(fs.realpathSync(argv1));
    const parts = (process.env.PATH || "").split(path.delimiter);
    for (const d of [dir, path.resolve(dir, "..")]) {
      if (d && !parts.includes(d)) process.env.PATH = d + path.delimiter + process.env.PATH;
    }
    // Where Claude installs itself. A shell that skipped ~/.zshrc (a login shell, a launcher,
    // tmux started from a script) has none of these, and then every Claude agent vanished.
    for (const d of [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local"), "/opt/homebrew/bin"]) {
      if (fs.existsSync(d) && !process.env.PATH.split(path.delimiter).includes(d)) process.env.PATH += path.delimiter + d;
    }
  } catch { /* argv[1] unreadable — leave PATH alone */ }
  return process.env.PATH;
}

export const has = (bin) => {
  try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; }
};

// ---- state ------------------------------------------------------------------
// `factory state --compact` is read-only and already the machine-readable twin of the board.
// null means factory is missing or broke; an empty hive list is a valid, different answer.
export function loadState() {
  try {
    const out = execFileSync("factory", ["state", "--compact"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const s = JSON.parse(out);
    if (!Array.isArray(s.hives)) return null;
    return s;
  } catch { return null; }
}

// The git repo containing `dir`, or null. A project is always its repo root: running `seldon
// go` from src/world/ must mean the same thing as running it from the top.
export function gitRootOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

const realish = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
export const sameDir = (a, b) => !!a && !!b && realish(a) === realish(b);


/**
 * What did the user mean, and what do we know about it?
 *   { kind: "hive"    , hive }           a registered project (by name, or we are standing in it)
 *   { kind: "repo"    , dir  }           a git repo that is not on the line yet
 *   { kind: "unknown" , arg  }           a name that matches nothing
 *   { kind: "nowhere" }                  no argument and not inside a repo
 */
export function resolveProject(arg, state) {
  const hives = state?.hives || [];
  if (arg) {
    const byName = hives.find((h) => h.name === arg);
    if (byName) return { kind: "hive", hive: byName, dir: byName.dir };
    const abs = path.resolve(arg);
    if (existsSync(abs)) {
      const root = gitRootOf(abs);
      if (!root) return { kind: "unknown", arg, reason: "not a git repo" };
      const byDir = hives.find((h) => sameDir(h.dir, root));
      return byDir ? { kind: "hive", hive: byDir, dir: byDir.dir } : { kind: "repo", dir: root };
    }
    return { kind: "unknown", arg, reason: "no such project or directory" };
  }
  const root = gitRootOf(process.cwd());
  if (!root) return { kind: "nowhere" };
  const byDir = hives.find((h) => sameDir(h.dir, root));
  return byDir ? { kind: "hive", hive: byDir, dir: byDir.dir } : { kind: "repo", dir: root };
}

// ---- actions (all delegated, all idempotent) --------------------------------
const passthru = (bin, args, opts = {}) => spawnSync(bin, args, { stdio: "inherit", ...opts }).status === 0;
const quiet = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
};

// `factory adopt` is the one command that both puts a repo on the line AND reopens a hive that
// is down (it reuses a reachable one, else opens it with the room history intact).
export const adopt = (dir, { verbose = true } = {}) =>
  verbose ? passthru("factory", ["adopt", dir]) : quiet("factory", ["adopt", dir]).ok;

export const staff = (dir, { agent, model, effort, name } = {}) => {
  const a = [];
  if (agent) a.push("--agent", agent);
  if (model) a.push("--model", model);
  if (effort) a.push("--effort", effort);
  if (name) a.push("--name", name);
  return passthru("factory", ["staff", dir, ...a]);
};

// `apiary room resume` is the human's seat: it restarts a stopped room, refreshes the share
// tokens and drops you into the TUI with the agent strip. It is also the thing nothing ever
// told you about.
export const attach = (name) => passthru("apiary", ["room", "resume", name]);

export const hiveOf = (state, dir) => (state?.hives || []).find((h) => sameDir(h.dir, dir)) || null;

// Forget a project: drop it from the factory's registry (~/.factory/hives.json). Its folder,
// git history and room file are left exactly as they are; `seldon go <dir>` brings it back.
export function forgetProject(name, reg = path.join(os.homedir(), ".factory", "hives.json")) {
  let list;
  try { list = JSON.parse(fs.readFileSync(reg, "utf8")); } catch { return { ok: false, error: "no factory registry here" }; }
  if (!Array.isArray(list)) return { ok: false, error: "the factory registry is not a list" };
  const kept = list.filter((h) => h?.name !== name);
  if (kept.length === list.length) return { ok: false, error: `${name} is not in the factory` };
  fs.writeFileSync(reg, JSON.stringify(kept, null, 2) + "\n");
  return { ok: true };
}
