// The I/O half of lanes.mjs: run the harness commands, resolve projects, hand back lanes.
// Every source is best-effort — a missing `claude` or no tmux server is an empty list, not
// an error, because a machine running only Codex (or nothing yet) is a normal machine.
import { execFileSync } from "node:child_process";
import {
  claudeLanes, parseTmuxPanes, tmuxLanes, tmuxSessionFor, groupByProject,
  projectRootFromCommonDir, TMUX_PANE_FORMAT,
} from "./lanes.mjs";

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

// All lanes, grouped by project, most urgent first. Claude lanes that live in a tmux pane
// (apiary's agents, or a claude you started inside tmux) learn which session, so ⏎ can open it.
export function readLanes() {
  const panes = readTmuxPanes();
  const claude = claudeLanes(readClaude()).map((l) =>
    l.id || !l.pid || !panes.length ? l : { ...l, tmuxSession: tmuxSessionFor(l.pid, panes, parentOf) });
  return groupByProject([...claude, ...tmuxLanes(panes)], projectRoot);
}
