#!/usr/bin/env node
// Every key, on every screen of the workspace, in a sealed sandbox.
//
//   node scripts/key-matrix.mjs                     every screen, every key (about 20 minutes)
//   KM_SCREENS=list,preview KM_KEYS=C-c,q node …    a subset
//   KM_BIN=/other/checkout/bin/seldon.js node …     test another version
//
// Nothing here can reach your real agents: `claude` is a fake that lists four made-up agents,
// HOME and SELDON_HOME are a temp folder, and every tmux server (the workspace, the agents',
// the terminal that holds the workspace) runs under its own TMUX_TMPDIR.
//
// Keys go in through the terminal that holds the workspace, like a keyboard, so tmux's own
// bindings (⌥ keys, Ctrl-g) run as well. After each key: the session exists, you are still in
// it, both panes are alive and drawn, no error is on screen, and nothing was typed into the
// agent that was working. ⌥q and Ctrl-g q (and q in the list) must leave, and the workspace
// must still be there to come back to.
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = process.env.KM_BIN || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/seldon.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "seldon-keys-"));
const HOME = path.join(ROOT, "home"), FAKE = path.join(ROOT, "bin"), SOCK = path.join(ROOT, "tmux");
for (const d of [HOME, FAKE, SOCK, path.join(HOME, "proj", ".git")]) fs.mkdirSync(d, { recursive: true });
const PROJ = path.join(HOME, "proj");
const ENV = { ...process.env, HOME, SELDON_HOME: path.join(HOME, ".seldon"), TMUX_TMPDIR: SOCK, SELDON_WS_SOCKET: "km-ws",
  PATH: `${FAKE}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` };
delete ENV.TMUX;
const tmux = (...a) => spawnSync("tmux", a, { env: ENV, encoding: "utf8" });
const ws = (...a) => tmux("-L", "km-ws", ...a);
const host = (...a) => tmux("-L", "km-host", ...a);
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);

// ---- the fake agents --------------------------------------------------------------------
// Two run in tmux on the sandbox's default server: `asker` waits with a numbered question,
// `worker` is busy. `cat` echoes whatever is typed into them, so the test can see it.
for (const s of ["asker", "worker"]) tmux("new-session", "-d", "-s", s, "-c", PROJ, "cat");
const pid = (s) => tmux("display", "-p", "-t", s, "#{pane_pid}").stdout.trim();
const agents = [
  { id: null, sessionId: "s-asker", pid: Number(pid("asker")), name: "asker", cwd: PROJ, kind: "interactive", state: "blocked", waitingFor: "you", startedAt: Date.now() - 6e5 },
  { id: null, sessionId: "s-worker", pid: Number(pid("worker")), name: "worker", cwd: PROJ, kind: "interactive", state: "working", startedAt: Date.now() - 3e6 },
  { id: "bg1", sessionId: "s-bg", pid: null, name: "background-one", cwd: PROJ, kind: "background", state: "blocked", waitingFor: "permission: Bash", startedAt: Date.now() - 9e5 },
  { id: "bg2", sessionId: "s-idle", pid: null, name: "sleepy", cwd: PROJ, kind: "background", state: "done", startedAt: Date.now() - 9e6 },
];
fs.writeFileSync(path.join(ROOT, "agents.json"), JSON.stringify(agents));
fs.writeFileSync(path.join(FAKE, "claude"), `#!/bin/sh
case "$1" in
  agents) cat "${path.join(ROOT, "agents.json")}" ;;
  attach) echo "fake claude session $2 (type anything; it echoes)"; exec cat ;;
  stop) exit 0 ;;
  *) exec cat ;;
esac
`, { mode: 0o755 });
const tdir = path.join(HOME, ".claude", "projects", "-proj"); fs.mkdirSync(tdir, { recursive: true });
const said = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
fs.writeFileSync(path.join(tdir, "s-asker.jsonl"), said("I added the form.\n\nShould a submitted URL go straight to the queue?\n\n1. straight to the queue\n2. manual review first") + "\n");
fs.writeFileSync(path.join(tdir, "s-worker.jsonl"), said("Running the eval set now.") + "\n");
fs.writeFileSync(path.join(tdir, "s-bg.jsonl"), said("May I run the migration?") + "\n");

// ---- the terminal that holds the workspace ----------------------------------------------
const attached = () => !!ws("list-clients").stdout.trim();
const startClient = () => {
  host("kill-server");
  host("new-session", "-d", "-s", "host", "-x", "150", "-y", "40", "-c", PROJ, `env -u TMUX ${process.execPath} ${BIN} ws; sleep 600`);
  // tmux holds an Esc for up to 500ms to see if it starts an Alt key; the screen reset sends Esc
  // before each key, so without this Esc + Ctrl-C arrived as Alt-Ctrl-C and hid the real bug
  host("set", "-s", "escape-time", "0");
  for (let i = 0; i < 60 && !attached(); i++) sleep(250);
  sleep(2500);
};
const opt = (o) => ws("show", "-v", "-t", "ws", o).stdout.trim();
const side = () => opt("@side"), main = () => opt("@main");
const cap = (p) => ws("capture-pane", "-p", "-t", p).stdout;
// focus a pane (as a click would), then type through the terminal
const send = (p, key) => { if (p) ws("select-pane", "-t", p); host("send-keys", "-t", "host", key); };

// ---- the screens, each reached from a fresh list ----------------------------------------
// Esc resets the list (clears a filter). Something in the chain holds an Esc for a moment to see
// if it starts an Alt key, so the next key waits, or Esc + Ctrl-C would arrive as Alt-Ctrl-C.
const home = () => { send(side(), "Escape"); sleep(1500); for (let i = 0; i < 5; i++) send(side(), "Up"); sleep(300); };   // and back to the top row
const SCREENS = {
  list: () => home(),
  filter: () => { home(); send(side(), "/"); sleep(700); },
  keys: () => { home(); send(side(), "?"); sleep(300); },
  preview: () => { home(); send(side(), "Enter"); sleep(2000); },                // the asker is on top
  typing: () => { SCREENS.preview(); send(main(), "a"); sleep(400); },
  confirm: () => { home(); send(side(), "Down"); sleep(300); send(side(), "Enter"); sleep(2000); send(main(), "x"); sleep(600); },
  projects: () => { home(); send(side(), "h"); sleep(2500); },
  docs: () => { home(); send(side(), "d"); sleep(1500); },
};
const where = { list: side, filter: side, keys: side, preview: main, typing: main, confirm: main, projects: main, docs: main };
// What each screen must show once reached: a key test on a screen that never opened proves nothing.
const MARK = { list: [side, /NEEDS YOU/], filter: [side, /⌕ ▏/], keys: [side, /ANYWHERE IN WS/], preview: [main, /straight to the queue/],
  typing: [main, /⏎ send · esc cancel/], confirm: [main, /Stop background-one\?|Stop worker\?/], projects: [main, /your projects/], docs: [main, /docs/] };

// ---- every key ----------------------------------------------------------------------------
const KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""), ..."ARDQX".split(""), ..."0123456789".split(""),
  "Enter", "Escape", "Tab", "BTab", "Up", "Down", "Left", "Right", "BSpace", "Space", "/", "?", "Home", "End", "PageUp", "PageDown",
  ..."abcdefhijklmnopqrstuvwxyz".split("").map((c) => `C-${c}`),          // every Ctrl key (C-g is seldon's prefix: below)
  "C-\\", "C-g 3", "C-g Left", "C-g Right", "C-g h", "C-g d", "C-g n", "C-g s", "C-g x", "C-g q",
  "M-1", "M-2", "M-9", "M-n", "M-s", "M-h", "M-d", "M-Left", "M-Right", "M-x", "M-z", "M-q",
];
// ⌥q and Ctrl-g q leave from anywhere; q leaves only from the list (elsewhere it is typed, or quits that screen)
const leaves = (screen, key) => key === "M-q" || key === "C-g q" || (key === "q" && screen === "list");
const only = (v) => (v ? new Set(v.split(",")) : null);
const ONLY_SCREENS = only(process.env.KM_SCREENS), ONLY_KEYS = only(process.env.KM_KEYS);

const problems = [];
const report = (screen, key, why) => problems.push(`${screen.padEnd(9)} ${key.padEnd(10)} ${why}`);
const check = (screen, key) => {
  const why = [];
  if (tmux("-L", "km-ws", "has-session", "-t", "ws").status !== 0) why.push("the workspace session is gone");
  else {
    if (!attached()) why.push("you were thrown out of the workspace (detached)");
    const panes = ws("list-panes", "-t", "ws", "-F", "#{pane_id} #{pane_dead}").stdout.trim().split("\n");
    if (panes.length !== 2) why.push(`${panes.length} panes instead of 2`);
    if (panes.some((l) => l.endsWith(" 1"))) why.push("a pane died");
    const s = cap(side()), m = cap(main());
    if (!/seldon/.test(s)) why.push("the list is not drawn");
    if (!m.trim()) why.push("the right pane is blank");
    const err = (s + m).match(/.*(TypeError|ReferenceError|Error:|\.mjs:\d+).*/);
    if (err) why.push("an error is on screen: " + err[0].trim());
  }
  const typed = tmux("capture-pane", "-p", "-t", "worker").stdout.trim();
  if (typed) why.push(`something was typed into the WORKING agent: "${typed.slice(-40)}"`);
  if (why.length) report(screen, key, why.join("; "));
};

startClient();
let n = 0;
for (const [screen, go] of Object.entries(SCREENS)) {
  if (ONLY_SCREENS && !ONLY_SCREENS.has(screen)) continue;
  for (const key of KEYS) {
    if (ONLY_KEYS && !ONLY_KEYS.has(key)) continue;
    if (!attached()) startClient();
    go();
    const [pane, mark] = MARK[screen];
    if (!mark.test(cap(pane()))) {
      if (process.env.KM_DEBUG) console.log(`--- ${screen} ${key} not reached; list:\n${cap(side())}\n--- right:\n${cap(main())}`);
      report(screen, key, "could not reach this screen"); continue;
    }
    ws("select-pane", "-t", where[screen]());
    for (const k of key.split(" ")) send(null, k);
    sleep(900);
    n++;
    if (leaves(screen, key)) {
      if (attached()) report(screen, key, "was meant to leave, did not");
      if (tmux("-L", "km-ws", "has-session", "-t", "ws").status !== 0) report(screen, key, "leaving killed the workspace");
      startClient();
      continue;
    }
    check(screen, key);
    // whatever the key opened (an agent, a prompt): back to a known state for the next key
    if (screen !== "list") ws("respawn-pane", "-k", "-t", main(), "sh", "-c", `trap '' INT QUIT TSTP; while :; do ${process.execPath} ${BIN} ws preview; sleep 0.3; done`);
  }
  if (!ONLY_KEYS) process.stdout.write(`${screen}: done\n`);
}

// Typing for one agent, then picking another: the half-typed text must never reach anyone.
if (!ONLY_KEYS || ONLY_KEYS.has("switch")) {
  if (!attached()) startClient();
  SCREENS.preview(); send(main(), "a"); sleep(300); for (const c of "oops") send(main(), c);
  send(side(), "Down"); sleep(2500); send(main(), "Enter"); sleep(1500);
  for (const s of ["asker", "worker"]) if (/oops/.test(tmux("capture-pane", "-p", "-t", s).stdout)) report("preview", "switch", `half-typed text reached ${s} after picking another agent`);
  if (/oops/.test(cap(main()))) report("preview", "switch", "the half-typed text is still there for another agent");
  n++;
}

// The answer path itself: 1 in the preview reaches the waiting agent and nothing else.
if (!ONLY_KEYS || ONLY_KEYS.has("answer")) {
  if (!attached()) startClient();
  tmux("clear-history", "-t", "asker"); tmux("send-keys", "-t", "asker", "-R", "");
  SCREENS.preview();
  send(main(), "1"); sleep(1500);
  const got = tmux("capture-pane", "-p", "-t", "asker").stdout;
  if (!/^1$/m.test(got)) report("preview", "1", `the waiting agent did not get the answer: ${JSON.stringify(got.trim().slice(-60))}`);
  if (!/told it: 1/.test(cap(main()))) report("preview", "1", "no 'told it' toast after answering");
  if (tmux("capture-pane", "-p", "-t", "worker").stdout.trim()) report("preview", "1", "the answer reached the WORKING agent too");
  n++;
}

host("kill-server"); ws("kill-server"); tmux("kill-server");
console.log(`\n${n} key presses on ${ONLY_SCREENS ? ONLY_SCREENS.size : Object.keys(SCREENS).length} screens`);
if (problems.length) { console.log(`${problems.length} problems:\n` + problems.join("\n")); process.exitCode = 1; }
else console.log("no problems: every key left the workspace whole, and nothing reached the working agent");
fs.rmSync(ROOT, { recursive: true, force: true });
