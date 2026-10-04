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

// A lane name nobody has used yet: "fix-it", else "fix-it-2", "fix-it-3"… Reusing a name
// collides with the branch or worktree an earlier lane of that name left behind.
export function uniqueSlug(base, isTaken) {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) if (!isTaken(`${base}-${n}`)) return `${base}-${n}`;
}

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
    { bin: "git", args: ["-C", root, "worktree", "add", "-b", `lane/${slug}`, wt], quiet: true },
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

// ---- after a reboot ---------------------------------------------------------------
// A tmux lane seldon started, whose session is gone, and that nobody stopped on purpose,
// died with the machine (or crashed). It is listed as stopped so it can be resumed.
export function registryLanes(entries, liveSessions) {
  const live = new Set(liveSessions);
  return (entries || []).filter((e) => e.session && !e.stoppedAt && !live.has(e.session)).map((e) => ({
    harness: e.harness,
    key: `tmux:${e.session}`,
    id: null,
    sessionId: null,
    pid: null,
    name: e.slug || e.session.replace(/^seldon_/, ""),
    cwd: e.worktree,
    kind: "tmux",
    startedAt: e.startedAt ?? null,
    state: "stopped",
    waitingFor: null,
    tmuxSession: e.session,
    task: e.task,
  }));
}

// How to bring a stopped lane back.
//   claude:   `claude respawn <id>` resumes its saved conversation.
//   codex:    `codex resume --last` is scoped to the current directory, and every lane has its
//             own worktree, so it picks up exactly this lane's conversation.
//   opencode: its "continue" is per project, and worktrees share one, so it could pick up a
//             sibling lane's conversation. It is restarted on the same task in the same
//             worktree instead (the work on disk is kept) — and says so.
export function resumeCommands(lane, { bins = {}, env = {} } = {}) {
  if (lane.harness === "claude" && lane.id) return { cmds: [{ bin: bins.claude || "claude", args: ["respawn", lane.id] }] };
  if (!lane.tmuxSession || !lane.cwd || !["codex", "opencode"].includes(lane.harness)) return { why: "seldon did not start it, so it cannot restart it" };
  const bin = bins[lane.harness] || lane.harness;
  const agent = lane.harness === "codex" ? [bin, "resume", "--last"] : [bin, lane.cwd, "--prompt", lane.task || "continue where you left off"];
  const envArgs = env.PATH ? ["-e", `PATH=${env.PATH}`] : [];
  return {
    cmds: [{ bin: "tmux", args: ["new-session", "-d", "-s", lane.tmuxSession, "-c", lane.cwd, ...envArgs, ...agent], session: lane.tmuxSession, agent, cwd: lane.cwd }],
    fresh: lane.harness === "opencode",
  };
}

// ---- telling the human ----------------------------------------------------------------
// What changed since the last look that a person should hear about: an agent that starts
// waiting on them, fails, or finishes. Only TRANSITIONS — a lane that stays blocked is not
// re-announced every tick, and a lane seen for the first time is not news.
const NEWS = { "needs-you": "needs you", failed: "failed", idle: "finished" };
export function transitions(prev, lanes) {
  const events = [];
  for (const l of lanes) {
    const was = prev.get(l.key);
    if (was === undefined || was === l.state || !NEWS[l.state]) continue;
    if (l.state === "idle" && !["working", "running"].includes(was)) continue;   // only work that just ended
    events.push({ lane: l, from: was, to: l.state, text: `${l.name || l.id} ${NEWS[l.state]}${l.state === "needs-you" && l.waitingFor ? `: ${l.waitingFor}` : ""}` });
  }
  return events;
}
