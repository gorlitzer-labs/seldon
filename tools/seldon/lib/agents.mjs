// The I/O half of lanes.mjs: run the harness commands, resolve projects, hand back lanes.
// Every source is best-effort — a missing `claude` or no tmux server is an empty list, not
// an error, because a machine running only Codex (or nothing yet) is a normal machine.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { applyReports } from "./reports.mjs";
import { sameDir } from "./projects.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  claudeLanes, parseTmuxPanes, tmuxLanes, tmuxSessionFor, groupByProject,
  projectRootFromCommonDir, registryLanes, TMUX_PANE_FORMAT,
} from "./lanes.mjs";

export const SELDON_HOME = process.env.SELDON_HOME || join(homedir(), ".seldon");
const LANES_FILE = join(SELDON_HOME, "lanes.json");
const STATE_DIR = join(SELDON_HOME, "state");

const out = (bin, args, timeout = 5000) => {
  try { return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }); }
  catch { return null; }
};

export function readClaude() {
  const raw = out("claude", ["agents", "--json", "--all"]);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

export const readTmuxPanes = () => parseTmuxPanes(out("tmux", ["list-panes", "-a", "-F", TMUX_PANE_FORMAT]) || "");

// A process's parent never changes, so `ps` is asked once per pid, not once per refresh.
const parents = new Map();
const parentOf = (pid) => {
  if (!parents.has(pid)) parents.set(pid, Number(out("ps", ["-o", "ppid=", "-p", String(pid)])?.trim()) || null);
  return parents.get(pid);
};

// cwd -> project root. A lane's cwd does not move between refreshes, so ask git once.
const rootCache = new Map();
export function projectRoot(cwd) {
  if (!cwd) return null;
  if (!rootCache.has(cwd)) {
    const common = out("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
    rootCache.set(cwd, projectRootFromCommonDir(common));
  }
  return rootCache.get(cwd);
}

// ---- what seldon started -----------------------------------------------------
// One record per lane seldon starts in tmux: which harness, which task, where. It is how a
// lane is recognised whatever its pane happens to run, and (later) how it is resumed.
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

const writeLanes = (all) => {
  mkdirSync(SELDON_HOME, { recursive: true });
  const tmp = `${LANES_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, LANES_FILE);
};

export function recordLane(entry) {
  writeLanes([...readJson(LANES_FILE, []).filter((e) => e.session !== entry.session), entry]);
}

// Stopped on purpose (x x): not offered for resume after a reboot. Resuming clears it.
export function markLane(session, patch) {
  writeLanes(readJson(LANES_FILE, []).map((e) => (e.session === session ? { ...e, ...patch } : e)));
}

// tmux session -> { harness, task, startedAt }: seldon's lanes plus apiary's Codex agents.
export function knownSessions() {
  const known = {};
  for (const e of readJson(LANES_FILE, [])) if (e.session) known[e.session] = e;
  const dir = join(homedir(), ".apiary", "sessions");
  let files = [];
  try { files = readdirSync(dir); } catch { /* no apiary */ }
  for (const f of files.filter((f) => f.startsWith("codex_") && f.endsWith(".json"))) {
    const s = readJson(join(dir, f), null);
    if (s?.tmuxSession) known[s.tmuxSession] = { harness: "codex" };
  }
  return known;
}

// All lanes, grouped by project, most urgent first. Claude lanes that live in a tmux pane
// (apiary's agents, or a claude you started inside tmux) learn which session, so ⏎ can open it.
export function readLanes() {
  const panes = readTmuxPanes();
  const claude = claudeLanes(readClaude()).map((l) =>
    l.id || !l.pid || !panes.length ? l : { ...l, tmuxSession: tmuxSessionFor(l.pid, panes, parentOf) });
  const stopped = registryLanes(readJson(LANES_FILE, []), panes.map((p) => p.session));
  const tmux = applyReports(tmuxLanes(panes, knownSessions()), readReports(), sameDir);
  return groupByProject([...claude, ...tmux, ...stopped], projectRoot);
}

// The project's open plan, via foundation (the one parser of QUEUE.md). null = no foundation
// or no plan here; [] = an empty plan.
export function readPlan(root) {
  const raw = out("foundation", ["queue", "--list", "--json", "--dir", root]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function addToPlan(root, text, priority = "P2") {
  return run({ bin: "foundation", args: ["queue", `(${priority}) ${text}`, "--dir", root] }, { quiet: true });
}

// Run a command with the terminal attached (a trust dialog may need answering), and say how
// it went. Steps run in order and stop at the first failure.
// `quiet` captures the output instead (for a command that would print over the panel), and
// its last line becomes the error.
export function run(cmd, { quiet = false } = {}) {
  const r = spawnSync(cmd.bin, cmd.args, { stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", cwd: cmd.cwd, encoding: "utf8" });
  const said = quiet ? `${r.stderr || ""}${r.stdout || ""}`.trim().split("\n").pop() : "";
  return { ok: r.status === 0, error: r.error ? r.error.message : r.status !== 0 ? (said || `${cmd.bin} exited ${r.status}`) : null };
}
export function runSteps(cmds) {
  for (const c of cmds) {
    const r = run(c);
    if (!r.ok) return r;
    // A tmux session that is gone a moment later means the agent exited at once (bad flag,
    // no login, not installed). Say so — "started" for something that is not running is the
    // one answer worse than an error.
    if (c.session) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      if (out("tmux", ["has-session", "-t", c.session]) === null)
        return { ok: false, error: `the agent exited right after starting — run it by hand to see why: cd ${c.cwd} && ${c.agent.join(" ")}` };
    }
  }
  return { ok: true };
}

// Absolute paths of the agent CLIs, resolved with seldon's own PATH.
export function harnessBins() {
  const bins = {};
  for (const h of ["claude", "codex", "opencode"]) {
    const p = out("sh", ["-c", `command -v ${h}`])?.trim();
    if (p) bins[h] = p;
  }
  return bins;
}

// ---- harness reports (see reports.mjs) -------------------------------------------
const reportFile = (r) => join(STATE_DIR, `${r.harness}-${String(r.session).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function writeReport(r) {
  if (!r) return;
  if (r.ended) { rmSync(reportFile(r), { force: true }); return; }
  mkdirSync(STATE_DIR, { recursive: true });
  const f = reportFile(r), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, f);
}

// Every report, newest state per session. Files untouched for 3 days are sessions that died
// without saying so; they are cleared as they are read.
export function readReports(now = Date.now()) {
  let files = [];
  try { files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    const p = join(STATE_DIR, f);
    try {
      if (now - statSync(p).mtimeMs > 3 * 86_400_000) { rmSync(p, { force: true }); continue; }
      out.push(JSON.parse(readFileSync(p, "utf8")));
    } catch { /* half-written or gone */ }
  }
  return out;
}
