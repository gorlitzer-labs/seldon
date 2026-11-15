// The workspace's rules, with no tmux and no agents: what the list shows, which agent a key
// means, and the exact shell line the right-hand pane runs for each kind of agent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  AGENT_POOL, emojiFor, assignEmoji, wsRows, nextNeeding, findRow, paneCommand, setupCommands, rowCells, wsHeadline,
  WS_SESSION, SIDE_WIDTH,
} from "../lib/workspace.mjs";

const lane = (o) => ({ harness: "claude", key: `claude:${o.name}`, id: o.name, state: "working", cwd: "/w/p", ...o });
const groups = [
  { name: "seldon", root: "/w/seldon", lanes: [lane({ name: "workspace", state: "needs-you", waitingFor: "permission: Bash" }), lane({ name: "docs" })] },
  { name: "weather @mini", root: "mini:/w/weather", lanes: [
    { harness: "codex", key: "mini/tmux:seldon_cache", remoteKey: "tmux:seldon_cache", name: "cache", state: "needs-you", machine: "mini", tmuxSession: "seldon_cache", cwd: "/w/weather" }] },
];
const HOME = "'node' 'seldon.js'";
const mini = { name: "mini", host: "mini.ts.net", user: "you" };

test("emojiFor: the same name always gets the same emoji, from the pool", () => {
  assert.equal(emojiFor("fix-save-crash"), emojiFor("fix-save-crash"));
  assert.ok(AGENT_POOL.includes(emojiFor("fix-save-crash")));
  assert.equal(new Set(AGENT_POOL).size, AGENT_POOL.length, "no emoji twice in the pool");
});

test("assignEmoji: agents on screen together never share one, whatever order they are listed in", () => {
  const names = Array.from({ length: 20 }, (_, i) => `lane-${i}`);
  const a = assignEmoji(names), b = assignEmoji([...names].reverse());
  assert.equal(new Set(a.values()).size, names.length);
  assert.deepEqual([...a].sort(), [...b].sort());
  // an agent that collides with nobody keeps the emoji it has everywhere else
  assert.equal(assignEmoji(["solo"]).get("solo"), emojiFor("solo"));
});

test("wsRows: one numbered row per agent, in the order given; an unreachable machine's agents are off", () => {
  const rows = wsRows(groups, new Set(["mini"]));
  assert.deepEqual(rows.map((r) => [r.n, r.name, r.project, r.off]), [[1, "workspace", "seldon", false], [2, "docs", "seldon", false], [3, "cache", "weather @mini", true]]);
  assert.equal(wsRows(groups)[2].off, false);
});

test("nextNeeding: the next agent waiting on you, wrapping round, skipping unreachable ones", () => {
  const rows = wsRows(groups);
  assert.equal(nextNeeding(rows, null).name, "workspace");
  assert.equal(nextNeeding(rows, "claude:workspace").name, "cache");
  assert.equal(nextNeeding(rows, "mini/tmux:seldon_cache").name, "workspace");
  assert.equal(nextNeeding(wsRows(groups, new Set(["mini"])), "claude:workspace").name, "workspace");   // the only one left
  assert.equal(nextNeeding(wsRows([{ name: "p", lanes: [lane({ name: "a" })] }]), null), null);
});

test("findRow: by number or by key", () => {
  const rows = wsRows(groups);
  assert.equal(findRow(rows, "2").name, "docs");
  assert.equal(findRow(rows, 2).name, "docs");
  assert.equal(findRow(rows, "mini/tmux:seldon_cache").name, "cache");
  assert.equal(findRow(rows, "9"), null);
});

test("paneCommand: a Claude lane is attached; when it closes the pane goes home", () => {
  const cmd = paneCommand(wsRows(groups)[0], { home: HOME });
  assert.match(cmd, /^'claude' 'attach' 'workspace' \|\| /);
  assert.ok(cmd.endsWith(`exec ${HOME}`));
});

test("paneCommand: a tmux lane is attached on the DEFAULT tmux server, not the workspace's", () => {
  const row = wsRows([{ name: "p", lanes: [{ harness: "codex", key: "tmux:seldon_x", name: "x", state: "running", tmuxSession: "seldon_x", cwd: "/w/p" }] }])[0];
  assert.match(paneCommand(row, { home: HOME }), /^'env' '-u' 'TMUX' 'tmux' 'attach' '-t' 'seldon_x' /);
});

test("paneCommand: a lane on another machine opens over ssh with a terminal, by its key there", () => {
  const cmd = paneCommand(wsRows(groups)[2], { machines: [mini], home: HOME });
  assert.match(cmd, /^'ssh' .*'-t' 'you@mini\.ts\.net' /);
  assert.match(cmd, /seldon.*lane.*open.*tmux:seldon_cache/);
  assert.doesNotMatch(cmd, /mini\/tmux/, "the key as that machine knows it, not this one's");
});

test("paneCommand: what cannot be opened says why and goes home, instead of a dead pane", () => {
  const off = paneCommand(wsRows(groups, new Set(["mini"]))[2], { machines: [mini], home: HOME });
  assert.match(off, /is paused/); assert.doesNotMatch(off, /ssh/);
  const unknown = paneCommand(wsRows(groups)[2], { machines: [], home: HOME });
  assert.match(unknown, /does not know the machine/);
  const plain = wsRows([{ name: "p", lanes: [{ harness: "claude", key: "claude:9", name: "in a terminal", state: "working", cwd: "/w/p" }] }])[0];
  assert.match(paneCommand(plain, { home: HOME }), /cannot open/);
  for (const c of [off, unknown]) assert.ok(c.endsWith(`exec ${HOME}`));
});

test("paneCommand: a name with a quote in it cannot break out of the shell line", () => {
  const row = wsRows([{ name: "p", lanes: [lane({ name: "it's; rm -rf ~", id: "it's; rm -rf ~" })] }])[0];
  const cmd = paneCommand(row, { home: "true" });
  // sh parses it, and the only thing it would run is `claude` with that one argument
  const argv = execFileSync("sh", ["-c", `claude() { printf '%s\\n' "$#" "$2"; }; ${cmd}`], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(argv, ["2", "it's; rm -rf ~"]);
});

test("setupCommands: options first, the two panes last, every key bound twice (Alt and Ctrl-g)", () => {
  const cmds = setupCommands({ self: HOME, home: "HOMECMD", cols: 120, rows: 30 });
  const verbs = cmds.map((c) => c[0]);
  assert.equal(verbs[0], "start-server");
  assert.deepEqual(verbs.slice(-2), ["new-session", "split-window"]);
  const session = cmds.at(-2), side = cmds.at(-1);
  assert.ok(session.includes(WS_SESSION) && session.at(-1) === "HOMECMD" && session.includes("120"));
  assert.ok(side.includes(String(SIDE_WIDTH)) && side.at(-1) === `${HOME} ws sidebar`);
  for (const c of [session, side]) assert.ok(c.includes("SELDON_WS=1"), "panes know they are in the workspace");
  assert.ok(cmds.some((c) => c.join(" ") === "set -g prefix None"), "no prefix: keys go to the agent");
  const binds = cmds.filter((c) => c[0] === "bind");
  for (const k of ["1", "9", "n", "s", "h", "q"]) {
    assert.ok(binds.some((c) => c[1] === "-n" && c[2] === `M-${k}`), `Alt-${k}`);
    assert.ok(binds.some((c) => c[1] === "-T" && c[2] === "seldon" && c[3] === k), `Ctrl-g ${k}`);
  }
  const alt3 = binds.find((c) => c[2] === "M-3");
  assert.deepEqual(alt3.slice(3), ["run-shell", "-b", `${HOME} ws pick 3`]);
});

test("rowCells: two short lines per agent that fit the width", () => {
  const rows = wsRows([{ name: "p", lanes: [lane({ name: "a-very-long-lane-name-that-will-not-fit-in-the-sidebar", state: "needs-you", waitingFor: "permission: Bash" })] },
    ...groups], new Set(["mini"]));
  const long = rowCells(rows[0], 38);
  assert.ok(long.name.length <= 27 && long.name.endsWith("…"));
  assert.ok(long.sub.length <= 30);
  assert.match(long.sub, /^needs you · permission/);
  assert.equal(long.glyph, "⚑");
  const offCells = rowCells(rows[3], 60);
  assert.deepEqual([offCells.glyph, offCells.state], ["☾", "off"]);
  assert.match(offCells.sub, /paused · mini unreachable · codex @mini/);
  assert.equal(rowCells(rows[2], 60, () => "12m").sub, "working · 12m · claude");
  assert.equal(rowCells({ ...rows[2], n: 12 }, 60).n, " ", "only 1-9 have a key");
});

test("wsHeadline: who needs you and who is busy, not counting unreachable machines", () => {
  assert.deepEqual(wsHeadline(wsRows(groups)), { need: 2, busy: 1, total: 3 });
  assert.deepEqual(wsHeadline(wsRows(groups, new Set(["mini"]))), { need: 1, busy: 1, total: 3 });
});
