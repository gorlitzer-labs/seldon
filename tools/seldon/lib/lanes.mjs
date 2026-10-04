// Lanes: every coding agent running on this machine, whatever harness it is, in one shape.
//
// A lane is one agent on one task. seldon does not launch or own them here — it reads them:
//   - Claude Code reports its own sessions: `claude agents --json --all` is the documented,
//     supported interface (https://code.claude.com/docs/en/agent-view). It covers interactive
//     sessions (including the ones apiary runs in tmux) and background ones.
//   - Codex and opencode have no equivalent list, so for now they are found as tmux panes
//     running that CLI. Their state is "running" until a harness adapter reports more.
//
// Everything in this file is pure: the callers do the I/O (run the commands, read git) and
// pass the results in, so the mapping rules are testable with fixtures and no agents running.

// ---- the one shape -----------------------------------------------------------
// state is what a human needs to know, ordered by urgency:
//   needs-you  the agent is waiting on a person (question, permission, login, dialog)
//   working    it is getting on with it
//   running    alive, but its harness does not say more (Codex/opencode via tmux, for now)
//   idle       finished its turn, ready for the next prompt
//   failed     ended with an error
//   stopped    stopped by someone, or ended at shutdown
export const STATES = ["needs-you", "working", "running", "idle", "failed", "stopped"];
const RANK = Object.fromEntries(STATES.map((s, i) => [s, i]));

// ---- Claude Code ---------------------------------------------------------------
// Background sessions carry `state`; every live process carries `status` (+ `waitingFor`).
// `state` is the authority when present — `status` only says whether the process is busy
// this instant, and a background session between loop iterations is "working" while idle.
const CLAUDE_STATE = { working: "working", blocked: "needs-you", done: "idle", failed: "failed", stopped: "stopped" };
const CLAUDE_STATUS = { busy: "working", waiting: "needs-you", idle: "idle" };

export function claudeLanes(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && typeof e.cwd === "string").map((e) => {
    const state = CLAUDE_STATE[e.state] ?? CLAUDE_STATUS[e.status] ?? (e.pid ? "running" : "stopped");
    return {
      harness: "claude",
      key: `claude:${e.id ?? e.sessionId ?? e.pid}`,
      id: e.id ?? null,                 // background sessions: usable with `claude attach`
      sessionId: e.sessionId ?? null,   // usable with `claude --resume`
      pid: e.pid ?? null,
      name: e.name ?? null,
      cwd: e.cwd,
      kind: e.kind ?? null,
      startedAt: e.startedAt ?? null,
      state,
      waitingFor: state === "needs-you" ? (e.waitingFor ?? "you") : null,
    };
  });
}

// ---- tmux (Codex, opencode) ------------------------------------------------------
// `tmux list-panes -a -F '#{session_name}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'`
// Claude panes are skipped: Claude reports itself, and listing it twice would double-count.
export const TMUX_PANE_FORMAT = "#{session_name}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}";
const TMUX_HARNESSES = new Set(["codex", "opencode"]);

export function parseTmuxPanes(text) {
  return String(text || "").split("\n").filter(Boolean).map((line) => {
    const [session, pid, command, cwd] = line.split("|");
    return { session, panePid: Number(pid) || null, command: command || "", cwd: cwd || "" };
  }).filter((p) => p.session);
}

// `known` maps a tmux session to what started it ({ harness, task, startedAt }) — seldon's own
// lanes registry and apiary's session files. That is the reliable signal: a pane's command
// name is often not the harness (codex installed from npm runs as a `node` wrapper), so the
// name match is only the fallback for agents started by hand.
export function tmuxLanes(panes, known = {}) {
  return panes.filter((p) => known[p.session] || TMUX_HARNESSES.has(p.command)).map((p) => ({
    harness: known[p.session]?.harness || p.command,
    key: `tmux:${p.session}`,
    id: null,
    sessionId: null,
    pid: p.panePid,
    name: p.session.replace(/^(apiary|seldon)_/, ""),
    cwd: p.cwd,
    kind: "tmux",
    startedAt: known[p.session]?.startedAt ?? null,
    state: "running",
    waitingFor: null,
    tmuxSession: p.session,
  }));
}

// The tmux session hosting a process: walk up its parents until one is a pane's shell.
// `parentOf(pid)` is injected (it shells out to `ps` in real use).
export function tmuxSessionFor(pid, panes, parentOf, maxDepth = 6) {
  const byPanePid = new Map(panes.map((p) => [p.panePid, p.session]));
  let cur = pid;
  for (let i = 0; cur && i < maxDepth; i++) {
    if (byPanePid.has(cur)) return byPanePid.get(cur);
    cur = parentOf(cur);
  }
  return null;
}

// ---- projects ------------------------------------------------------------------
// A lane belongs to the repo its cwd is in. A git worktree belongs to its MAIN repo, not to
// itself: an agent in .claude/worktrees/fix-x is working on the project, and reading its
// toplevel instead is how a working agent used to count as "nobody working here".
// `git rev-parse --path-format=absolute --git-common-dir` gives <main repo>/.git for both.
export function projectRootFromCommonDir(commonDir) {
  if (!commonDir) return null;
  const d = commonDir.replace(/\/+$/, "");
  return d.endsWith("/.git") ? d.slice(0, -"/.git".length) : d;
}

export function groupByProject(lanes, rootOf) {
  const groups = new Map();
  for (const lane of lanes) {
    const root = rootOf(lane.cwd) || lane.cwd;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ ...lane, project: root });
  }
  return [...groups].map(([root, ls]) => ({ root, name: root.split("/").pop() || root, lanes: sortLanes(ls) }))
    .sort((a, b) => urgency(a.lanes) - urgency(b.lanes) || a.name.localeCompare(b.name));
}

// Most urgent first; within a state, newest first.
export function sortLanes(lanes) {
  return [...lanes].sort((a, b) => (RANK[a.state] ?? 99) - (RANK[b.state] ?? 99) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

const urgency = (lanes) => Math.min(...lanes.map((l) => RANK[l.state] ?? 99));

export function countByState(lanes) {
  const c = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const l of lanes) c[l.state] = (c[l.state] ?? 0) + 1;
  return c;
}

// What one keypress should do to open a lane, or why it cannot. Decided here so the panel
// stays a dumb renderer and the rule is tested.
export function openCommand(lane) {
  if (lane.harness === "claude" && lane.id) return { bin: "claude", args: ["attach", lane.id] };
  if (lane.tmuxSession) return { bin: "tmux", args: ["attach", "-t", lane.tmuxSession] };
  if (lane.harness === "claude" && lane.sessionId && (lane.state === "stopped" || lane.state === "failed"))
    return { bin: "claude", args: ["--resume", lane.sessionId], cwd: lane.cwd };
  return { why: "it runs in a terminal seldon cannot reach — switch to that window" };
}

// ---- starting and stopping lanes -------------------------------------------------
// A lane's name is its task, slugged: it names the session, the branch and the worktree, so
// the plan item, the running agent and the branch on GitHub all read the same.
export function slugify(task, max = 40) {
  const s = String(task).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/, "") || "lane");
}

export const HARNESSES = ["claude", "codex", "opencode"];

// The commands that start a lane, in order. Claude makes and owns its worktree (`-w`) and runs
// under its own supervisor (`--bg`), so it survives the terminal and shows in `claude agents`.
// Codex and opencode have neither, so seldon makes the worktree (outside the repo, so it never
// shows up as untracked files) and hosts the agent in a tmux session named seldon_<slug>.
//   claude:   https://code.claude.com/docs/en/agent-view  (`claude --bg`, `-w`, `-n`)
//   codex:    `codex -C <dir> "PROMPT"`   opencode: `opencode <dir> --prompt "PROMPT"`
//
// tmux runs a session's command with the tmux SERVER's environment, not the caller's — so a
// bare `codex` resolves (or fails to) against whatever PATH the server started with, and the
// agent exits at once. `bins` maps harness -> absolute path and `env.PATH` is handed to the
// session, so the agent and everything it spawns see the PATH seldon saw.
export function startCommands({ harness, task, root, slug, worktreesDir, bins = {}, env = {} }) {
  if (harness === "claude") return [{ bin: bins.claude || "claude", args: ["--bg", "-w", slug, "-n", slug, task], cwd: root }];
  const wt = `${worktreesDir}/${slug}`;
  const bin = bins[harness] || harness;
  const agent = harness === "codex" ? [bin, "-C", wt, task] : [bin, wt, "--prompt", task];
  const envArgs = env.PATH ? ["-e", `PATH=${env.PATH}`] : [];
  return [
    { bin: "git", args: ["-C", root, "worktree", "add", "-b", `lane/${slug}`, wt] },
    { bin: "tmux", args: ["new-session", "-d", "-s", `seldon_${slug}`, "-c", wt, ...envArgs, ...agent], session: `seldon_${slug}`, agent, cwd: wt },
  ];
}

export function stopCommand(lane) {
  if (lane.harness === "claude" && lane.id) return { bin: "claude", args: ["stop", lane.id] };
  if (lane.tmuxSession && lane.harness !== "claude") return { bin: "tmux", args: ["kill-session", "-t", lane.tmuxSession] };
  return { why: "it is not a background session — stop it where it runs" };
}

// Which running lane is working on a plan item: the one named after it (seldon starts lanes
// with the item's slug as name, session and worktree).
export function laneForItem(item, lanes) {
  const slug = slugify(item.text);
  return lanes.find((l) => l.name === slug || l.tmuxSession === `seldon_${slug}` || (l.cwd || "").split("/").pop() === slug) || null;
}
