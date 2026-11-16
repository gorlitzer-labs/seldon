// The workspace: every agent in a list on the left, the selected agent's own terminal on the
// right, one key to switch. It is a tmux session on its own server (`tmux -L seldon-ws`), so
// its keys and options never touch the tmux you already use, and an agent that itself lives in
// tmux is simply attached inside the right-hand pane.
//
// Switching never stops an agent: the right-hand pane only holds a client (`claude attach`,
// `tmux attach`, or ssh to another machine's `seldon lane open`). Replacing the pane ends the
// client, not the agent.
//
// Everything here is pure: bin/seldon.js runs tmux and reads the lanes, and passes them in.
import { openCommand } from "./lanes.mjs";
import { sshArgs } from "./machines.mjs";

export const WS_SOCKET = process.env.SELDON_WS_SOCKET || "seldon-ws";   // a test copy can run beside the real one
export const WS_SESSION = "ws";
export const SIDE_WIDTH = 38;
export const NARROW = 90;          // below this many columns one pane fills the screen (a phone)

// ---- a face for every agent --------------------------------------------------------
// The same name always gets the same emoji (apiary does this for its agents), so an agent is
// recognisable in the list, in its pane title and across machines without reading its name.
export const AGENT_POOL = [
  "🦊", "🐙", "🦉", "🐢", "🦁", "🐧", "🦄", "🐳", "🦖", "🐝", "🦋", "🐺", "🦜", "🐸", "🦔", "🐼",
  "🦀", "🐬", "🦩", "🐿️", "🦥", "🦦", "🐨", "🦈", "🐊", "🦚", "🐌", "🦇", "🐗", "🦬", "🦭", "🪼",
];
const hash = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
export const emojiFor = (name, pool = AGENT_POOL) => pool[hash(name) % pool.length];

// One emoji each for the agents on screen together. Each takes its own (hashed) one; when two
// would share, the later name alphabetically moves to the next free one, so the answer does
// not depend on the order the agents are listed in.
export function assignEmoji(names, pool = AGENT_POOL) {
  const out = new Map(), used = new Set();
  for (const name of [...new Set(names)].sort()) {
    let i = hash(name) % pool.length;
    for (let n = 0; used.has(pool[i]) && n < pool.length; n++) i = (i + 1) % pool.length;
    used.add(pool[i]); out.set(name, pool[i]);
  }
  return out;
}

// ---- the list ----------------------------------------------------------------------
// One numbered row per agent, in the order the panel shows them (the ones waiting first).
// `down` is the set of machines that did not answer: their agents stay listed, marked off.
export function wsRows(groups, down = new Set()) {
  const rows = [];
  for (const g of groups) {
    for (const lane of g.lanes) {
      rows.push({
        n: rows.length + 1,
        key: lane.key,
        name: lane.name || lane.id || lane.key,
        project: g.name,
        harness: lane.harness,
        state: lane.state,
        waitingFor: lane.waitingFor || null,
        startedAt: lane.startedAt || null,
        machine: lane.machine || null,
        off: !!lane.machine && down.has(lane.machine),
        lane,
      });
    }
  }
  // Sorted by what they need from you, then numbered in that order, so ⌥1 is always the
  // agent most worth your attention. The sort is stable: inside a group, project order stays.
  rows.sort((a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b)));
  rows.forEach((r, i) => { r.n = i + 1; r.group = groupOf(r); });
  return rows;
}

// The list's groups, in the order they are shown.
export const GROUP_ORDER = ["needs you", "working", "idle", "stopped", "paused", "gone"];
export function groupOf(row) {
  if (row.off) return "paused";
  if (row.state === "gone") return "gone";
  if (row.state === "needs-you") return "needs you";
  if (row.state === "working" || row.state === "running") return "working";
  if (row.state === "stopped" || row.state === "failed") return "stopped";
  return "idle";
}

// The next agent waiting on you after `currentKey`, wrapping round. null when nobody is.
export function nextNeeding(rows, currentKey) {
  const live = rows.filter((r) => !r.off);
  const at = live.findIndex((r) => r.key === currentKey);
  for (let k = 1; k <= live.length; k++) {
    const r = live[(at + k) % live.length];
    if (r.state === "needs-you") return r;
  }
  return null;
}

// A row by its number ("3") or its key.
export const findRow = (rows, ref) => rows.find((r) => String(r.n) === String(ref) || r.key === ref) || null;

// ---- what the right-hand pane runs ---------------------------------------------------
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const shJoin = (argv) => argv.map(sq).join(" ");

// The shell line that opens one agent. When its client exits (you detached, the agent ended,
// the machine dropped) the pane falls back to `home`, the full panel, instead of dying.
// A failure stays on screen long enough to read.
export function paneCommand(row, { machines = [], home }) {
  const lane = row.lane;
  let open;
  if (row.state === "gone") return `printf '\\n  %s is gone: it stopped before its first answer, so there is nothing to reopen.\\n  In the list: ⏎, then x removes it.\\n' ${sq(row.name)}; sleep 6; exec ${home}`;
  if (row.off) return `printf '\\n  %s is paused: %s is not reachable. It carries on when that machine is back.\\n' ${sq(row.name)} ${sq(row.machine)}; sleep 6; exec ${home}`;
  if (lane.machine) {
    const m = machines.find((x) => x.name === lane.machine);
    if (!m) return `printf '\\n  seldon does not know the machine %s\\n' ${sq(lane.machine)}; sleep 6; exec ${home}`;
    open = shJoin(["ssh", ...sshArgs(m, ["seldon", "lane", "open", lane.remoteKey || lane.key], { tty: true })]);
  } else {
    const how = openCommand(lane);
    if (how.why) return `printf '\\n  cannot open %s here: %s\\n' ${sq(row.name)} ${sq(how.why)}; sleep 6; exec ${home}`;
    // The lane's tmux lives on the default server; this pane's $TMUX points at the workspace's.
    const argv = how.bin === "tmux" ? ["env", "-u", "TMUX", "tmux", ...how.args] : [how.bin, ...how.args];
    open = (how.cwd ? `cd ${sq(how.cwd)} && ` : "") + shJoin(argv);
  }
  return `${open} || { printf '\\n  seldon: %s closed with an error\\n' ${sq(row.name)}; sleep 5; }; exec ${home}`;
}

// ---- the tmux session ----------------------------------------------------------------
// `self` is the absolute `node seldon.js`, shell-quoted (tmux runs commands with its server's
// PATH, not yours); `home` is what the right-hand pane shows when no agent is open. Returned
// as argv lists, in order, for one `tmux -L seldon-ws` call.
export function setupCommands({ self, home = self, cols = 200, rows = 50 }) {
  const argv = (...a) => ["run-shell", "-b", `${self} ws ${a.join(" ")}`];
  const line = (...a) => `run-shell -b ${sq(`${self} ws ${a.join(" ")}`)}`;       // a hook takes one string
  const cmds = [
    ["start-server"],
    ["set", "-g", "default-terminal", "screen-256color"], ["set", "-as", "terminal-features", ",*:RGB"],
    ["set", "-g", "extended-keys", "on"], ["set", "-g", "history-limit", "20000"],
    // No prefix key: every key goes to the agent, except the ones bound below.
    ["set", "-g", "prefix", "None"], ["set", "-g", "prefix2", "None"],
    ["set", "-g", "mouse", "on"], ["set", "-g", "escape-time", "10"], ["set", "-g", "focus-events", "on"],
    // The look of ~/.tmux.conf: a neon ▲ block on the left, the time on the right, a green border
    // round the pane you are in and its title on top.
    ["set", "-g", "status", "on"], ["set", "-g", "status-style", "bg=#0b0f14,fg=#5c6370"],
    ["set", "-g", "status-left", "#[fg=#0b0f14,bg=#00ff9c,bold] ▲ seldon #[bg=#0b0f14,fg=#00ff9c,nobold] "], ["set", "-g", "status-left-length", "16"],
    ["set", "-g", "status-right", "#[fg=#5c6370]⌥1-9 agent · ⌥← list · ⌥→ right · ⌥h home · ⌥d docs · ⌥n next ⚑ · ⌥q leave  #[fg=#00ff9c,bold]%H:%M "],
    ["set", "-g", "status-right-length", "90"], ["set", "-g", "window-status-format", ""], ["set", "-g", "window-status-current-format", ""],
    // The pane you are in is a shade lighter; the divider is one quiet line. tmux's default with
    // two panes colours half the shared border, which reads as a broken line, not as focus.
    ["set", "-g", "pane-border-style", "fg=#1f2a33"], ["set", "-g", "pane-active-border-style", "fg=#1f2a33"],
    ["set", "-g", "pane-border-indicators", "off"], ["set", "-g", "pane-border-lines", "single"],
    ["set", "-g", "window-style", "bg=#0b0f14"], ["set", "-g", "window-active-style", "bg=#121920"],
    ["set", "-g", "pane-border-status", "off"],            // one title per pane: the screen's own
    ["set", "-g", "pane-border-format", " #{?pane_active,#[fg=#00ff9c]#[bold],#[fg=#5c6370]}#{pane_title} "],
    ["set", "-g", "allow-set-title", "off"],                // the agent cannot rename its pane
    ["set", "-g", "message-style", "bg=#00ff9c,fg=#0b0f14,bold"], ["set", "-g", "mode-style", "bg=#00ff9c,fg=#0b0f14"],
    ["set-environment", "-g", "SELDON_WS", "1"],
    // One pane fills a small screen; both show on a wide one. Re-checked whenever a screen attaches or resizes.
    ["set-hook", "-g", "client-attached", line("fit")], ["set-hook", "-g", "client-resized", line("fit")],
    // Alt-<key> directly, and Ctrl-g then <key> for terminals that do not send Alt (macOS
    // Terminal and iTerm2 need "Option as Meta" turned on).
    ["bind", "-n", "C-g", "switch-client", "-T", "seldon"],
  ];
  const keys = { n: ["next"], s: ["list"], h: ["home"], d: ["docs"] };
  for (let i = 1; i <= 9; i++) keys[i] = ["pick", i];
  for (const [k, a] of Object.entries(keys)) {
    cmds.push(["bind", "-n", `M-${k}`, ...argv(...a)], ["bind", "-T", "seldon", String(k), ...argv(...a)]);
  }
  cmds.push(["bind", "-n", "M-q", "detach-client"], ["bind", "-T", "seldon", "q", "detach-client"]);
  // Alt-← the list, Alt-→ the right pane as it is (Alt-h replaces it with home). On a phone
  // these flip between the two full-screen views.
  cmds.push(["bind", "-n", "M-Left", ...argv("list")], ["bind", "-T", "seldon", "Left", ...argv("list")],
    ["bind", "-n", "M-Right", ...argv("main")], ["bind", "-T", "seldon", "Right", ...argv("main")]);
  // The session last, so both panes start with every option above already in force.
  cmds.push(
    ["new-session", "-d", "-s", WS_SESSION, "-x", String(cols), "-y", String(rows), "-n", "seldon", "-e", "SELDON_WS=1", home],
    // the list restarts itself if it ever exits, so the pane can never be left empty
    ["split-window", "-hb", "-t", `${WS_SESSION}:0`, "-l", String(SIDE_WIDTH), "-e", "SELDON_WS=1", `sh -c ${sq(`trap '' INT QUIT TSTP; while :; do ${self} ws sidebar; sleep 0.3; done`)}`],
    ["select-pane", "-t", `${WS_SESSION}:0.0`, "-T", "agents"], ["select-pane", "-t", `${WS_SESSION}:0.1`, "-T", "home"],
  );
  return cmds;
}

// ---- drawing the list ------------------------------------------------------------------
const GLYPH = { "needs-you": "⚑", working: "●", running: "●", idle: "○", failed: "✗", stopped: "·" };
const WORDS = { "needs-you": "needs you", working: "working", running: "running", idle: "idle", failed: "failed", stopped: "stopped" };
const cut = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s);

// The two lines of one agent, as plain cells the caller colours:
//   { n, glyph, emoji, name, sub }  — name and sub already cut to fit `width` columns.
// `emoji` comes from assignEmoji when several agents are drawn together.
export function rowCells(row, width = SIDE_WIDTH, ago = () => "", emoji = emojiFor(row.name)) {
  const state = row.off ? "off" : row.state;
  const where = row.machine ? ` @${row.machine}` : "";
  const what = row.off ? `paused · ${row.machine} unreachable`
    : row.state === "needs-you" ? `needs you · ${row.waitingFor || "input"}`
    : [WORDS[row.state] || row.state, ago(row.startedAt)].filter(Boolean).join(" · ");
  return {
    n: row.n <= 9 ? String(row.n) : " ",
    glyph: row.off ? "☾" : GLYPH[row.state] || "?",
    emoji,
    state,
    name: cut(row.name, Math.max(6, width - 11)),
    sub: cut(`${what} · ${row.harness}${where}`, Math.max(6, width - 8)),
  };
}

export function wsHeadline(rows) {
  const live = rows.filter((r) => !r.off);
  const need = live.filter((r) => r.state === "needs-you").length;
  const busy = live.filter((r) => r.state === "working" || r.state === "running").length;
  return { need, busy, total: rows.length };
}

// ---- too small ---------------------------------------------------------------------
// Below this a list row no longer fits on one line and the footer pushes the agents off
// screen. Like btop: say so, centred, instead of drawing a broken screen.
export const MIN_COLS = 30, MIN_ROWS = 10;   // the list pane is 38 wide: it must fit
export function tooSmall(cols, rows, min = { cols: MIN_COLS, rows: MIN_ROWS }) {
  if (!cols || !rows || (cols >= min.cols && rows >= min.rows)) return null;
  const lines = ["terminal too small", `${cols}×${rows} · needs ${min.cols}×${min.rows}`, "make the window bigger"];
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  return [...Array(top).fill(""), ...lines.map((l) => " ".repeat(Math.max(0, Math.floor((cols - l.length) / 2))) + l)];
}

// ---- the keys, in one place ----------------------------------------------------------
// The ? card in the list and the panel, and the KEYS part of `seldon help`, all draw this.
export const KEYS = [
  ["anywhere in ws", [["⌥1-9", "open that agent"], ["⌥←", "the agent list"], ["⌥→", "the right pane"], ["⌥h", "projects"], ["⌥d", "docs, searchable"],
    ["⌥n", "next agent that needs you"], ["⌥q", "leave, agents keep going"], ["⌃g", "then the key, if ⌥ fails"]]],
  ["in the list", [["↑↓ ⏎", "pick · read its question"], ["/", "filter by name"], ["n", "new agent"], ["⇥", "next that needs you"], ["h d", "projects · docs"]]],
  ["reading an agent", [["1-9", "pick its numbered option"], ["a", "type an answer"], ["⏎", "open it"], ["←", "back to the list"], ["x", "stop it (asks first)"]]],
  ["in projects", [["⏎", "the plan"], ["n", "new agent"], ["g", "open: room + agent (asks)"], ["x", "forget (asks)"], ["R", "resume"]]],
];
export function keyLines(paint = {}) {
  const k = paint.key || ((x) => x), d = paint.dim || ((x) => x), t = paint.title || ((x) => x);
  const out = [];
  KEYS.forEach(([title, keys], i) => {
    if (i) out.push("");
    out.push(t(title.toUpperCase()));
    for (const [key, what] of keys) out.push(`${k(key.padEnd(6))} ${d(what)}`);
  });
  return out;
}
