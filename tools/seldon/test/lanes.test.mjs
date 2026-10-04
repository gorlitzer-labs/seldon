/**
 * lanes.mjs — every agent, whatever harness, in one shape. The fixtures are real
 * `claude agents --json` shapes (https://code.claude.com/docs/en/agent-view#list-sessions-as-json)
 * and real `tmux list-panes` lines.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  claudeLanes, parseTmuxPanes, tmuxLanes, tmuxSessionFor, groupByProject,
  projectRootFromCommonDir, sortLanes, countByState, openCommand,
} from "../lib/lanes.mjs";

const interactive = (o) => ({ cwd: "/r/app", kind: "interactive", startedAt: 1, pid: 10, sessionId: "s-1", name: "app-1", ...o });
const background = (o) => ({ cwd: "/r/app", kind: "background", startedAt: 1, id: "ab12", sessionId: "s-2", ...o });

describe("claudeLanes", () => {
  test("interactive status maps to a state", () => {
    const [busy, waiting, idle] = claudeLanes([
      interactive({ status: "busy" }),
      interactive({ status: "waiting", waitingFor: "permission prompt" }),
      interactive({ status: "idle" }),
    ]);
    assert.equal(busy.state, "working");
    assert.equal(waiting.state, "needs-you");
    assert.equal(waiting.waitingFor, "permission prompt");
    assert.equal(idle.state, "idle");
  });

  test("a background session's state outranks its process status", () => {
    // Between /loop iterations the process is idle but the session is still working.
    assert.equal(claudeLanes([background({ state: "working", status: "idle", pid: 3 })])[0].state, "working");
    assert.equal(claudeLanes([background({ state: "blocked", status: "waiting", pid: 3 })])[0].state, "needs-you");
    assert.equal(claudeLanes([background({ state: "done" })])[0].state, "idle");
    assert.equal(claudeLanes([background({ state: "failed" })])[0].state, "failed");
    assert.equal(claudeLanes([background({ state: "stopped" })])[0].state, "stopped");
  });

  test("blocked with no waitingFor still says it needs you", () => {
    assert.equal(claudeLanes([background({ state: "blocked" })])[0].waitingFor, "you");
  });

  test("garbage in, empty out", () => {
    assert.deepEqual(claudeLanes(null), []);
    assert.deepEqual(claudeLanes([{ nope: 1 }]), []);
  });
});

describe("tmux lanes", () => {
  const panes = parseTmuxPanes([
    "apiary_lint|500|codex|/r/anatomy",
    "apiary_docs|501|opencode|/r/weather",
    "seldon|502|claude|/r/seldon",
    "scratch|503|zsh|/r/x",
  ].join("\n"));

  test("Codex and opencode panes become lanes; Claude panes do not (Claude reports itself)", () => {
    const ls = tmuxLanes(panes);
    assert.deepEqual(ls.map((l) => [l.harness, l.name, l.state]), [["codex", "lint", "running"], ["opencode", "docs", "running"]]);
    assert.equal(ls[0].tmuxSession, "apiary_lint");
  });

  test("a process finds its tmux session through its parents", () => {
    const parents = { 900: 800, 800: 502 };
    assert.equal(tmuxSessionFor(900, panes, (p) => parents[p] ?? null), "seldon");
    assert.equal(tmuxSessionFor(42, panes, () => null), null);
  });
});

describe("projects", () => {
  test("a worktree belongs to its main repo", () => {
    assert.equal(projectRootFromCommonDir("/r/app/.git"), "/r/app");
    assert.equal(projectRootFromCommonDir("/r/app/.git/"), "/r/app");
    assert.equal(projectRootFromCommonDir(null), null);
  });

  test("lanes group by project, the project with a lane that needs you first", () => {
    const roots = { "/r/a": "/r/a", "/r/a/.claude/worktrees/x": "/r/a", "/r/b": "/r/b" };
    const groups = groupByProject([
      { key: 1, cwd: "/r/a", state: "idle" },
      { key: 2, cwd: "/r/a/.claude/worktrees/x", state: "working" },
      { key: 3, cwd: "/r/b", state: "needs-you" },
    ], (c) => roots[c]);
    assert.deepEqual(groups.map((g) => g.name), ["b", "a"]);
    assert.deepEqual(groups[1].lanes.map((l) => l.key), [2, 1]);
  });

  test("a cwd outside any repo is its own project", () => {
    assert.equal(groupByProject([{ key: 1, cwd: "/tmp/x", state: "idle" }], () => null)[0].root, "/tmp/x");
  });
});

test("sort and count", () => {
  const ls = sortLanes([{ state: "idle" }, { state: "needs-you" }, { state: "working", startedAt: 1 }, { state: "working", startedAt: 2 }]);
  assert.deepEqual(ls.map((l) => l.state + (l.startedAt ?? "")), ["needs-you", "working2", "working1", "idle"]);
  assert.equal(countByState(ls)["working"], 2);
});

describe("openCommand", () => {
  test("background Claude attaches by id", () => {
    assert.deepEqual(openCommand({ harness: "claude", id: "ab12" }), { bin: "claude", args: ["attach", "ab12"] });
  });
  test("anything in tmux attaches to its session", () => {
    assert.deepEqual(openCommand({ harness: "codex", tmuxSession: "apiary_lint" }), { bin: "tmux", args: ["attach", "-t", "apiary_lint"] });
  });
  test("a stopped Claude resumes its conversation", () => {
    assert.deepEqual(openCommand({ harness: "claude", sessionId: "s", state: "stopped", cwd: "/r" }), { bin: "claude", args: ["--resume", "s"], cwd: "/r" });
  });
  test("an interactive Claude in some other terminal says so instead of guessing", () => {
    assert.ok(openCommand({ harness: "claude", state: "working", pid: 3 }).why);
  });
});

import { slugify, startCommands, stopCommand, laneForItem } from "../lib/lanes.mjs";

describe("starting and stopping lanes", () => {
  test("slugs are kebab, bounded, never empty", () => {
    assert.equal(slugify("Port the bloom shader to Metal!"), "port-the-bloom-shader-to-metal");
    assert.ok(slugify("x".repeat(80)).length <= 40);
    assert.equal(slugify("!!!"), "lane");
  });

  test("Claude starts in the background, in its own worktree, named after the task", () => {
    assert.deepEqual(startCommands({ harness: "claude", task: "fix it", root: "/r/a", slug: "fix-it" }),
      [{ bin: "claude", args: ["--bg", "-w", "fix-it", "-n", "fix-it", "fix it"], cwd: "/r/a" }]);
  });

  test("Codex and opencode get a seldon worktree outside the repo and a tmux session", () => {
    const [wt, run] = startCommands({ harness: "codex", task: "fix it", root: "/r/a", slug: "fix-it", worktreesDir: "/h/.seldon/worktrees/a" });
    assert.deepEqual(wt.args, ["-C", "/r/a", "worktree", "add", "-b", "lane/fix-it", "/h/.seldon/worktrees/a/fix-it"]);
    assert.deepEqual(run.args.slice(0, 6), ["new-session", "-d", "-s", "seldon_fix-it", "-c", "/h/.seldon/worktrees/a/fix-it"]);
    assert.deepEqual(run.args.slice(6), ["codex", "-C", "/h/.seldon/worktrees/a/fix-it", "fix it"]);
    const oc = startCommands({ harness: "opencode", task: "t", root: "/r", slug: "t", worktreesDir: "/w" })[1];
    assert.deepEqual(oc.args.slice(6), ["opencode", "/w/t", "--prompt", "t"]);
  });

  test("stop: background Claude by id, tmux lanes by session, anything else says why", () => {
    assert.deepEqual(stopCommand({ harness: "claude", id: "ab" }), { bin: "claude", args: ["stop", "ab"] });
    assert.deepEqual(stopCommand({ harness: "codex", tmuxSession: "seldon_x" }), { bin: "tmux", args: ["kill-session", "-t", "seldon_x"] });
    assert.ok(stopCommand({ harness: "claude", pid: 3, tmuxSession: "work" }).why, "never kills a human's tmux session hosting claude");
  });

  test("a plan item finds the lane started for it", () => {
    const lanes = [{ name: "other" }, { name: "x", cwd: "/r/a/.claude/worktrees/port-bloom" }, { tmuxSession: "seldon_fix-crash" }];
    assert.equal(laneForItem({ text: "Port bloom" }, lanes), lanes[1]);
    assert.equal(laneForItem({ text: "fix crash" }, lanes), lanes[2]);
    assert.equal(laneForItem({ text: "nothing" }, lanes), null);
  });
});

test("tmux lanes get the agent's absolute path and seldon's PATH (tmux uses the server's env otherwise)", () => {
  const [, run] = startCommands({ harness: "opencode", task: "t", root: "/r", slug: "t", worktreesDir: "/w", bins: { opencode: "/opt/bin/opencode" }, env: { PATH: "/opt/bin:/usr/bin" } });
  assert.deepEqual(run.args, ["new-session", "-d", "-s", "seldon_t", "-c", "/w/t", "-e", "PATH=/opt/bin:/usr/bin", "/opt/bin/opencode", "/w/t", "--prompt", "t"]);
  assert.equal(run.session, "seldon_t");
  assert.deepEqual(run.agent, ["/opt/bin/opencode", "/w/t", "--prompt", "t"]);
});

test("a known session is a lane whatever its pane runs (npm codex shows as node)", () => {
  const panes = parseTmuxPanes("seldon_fix|700|node|/w/fix\nother|701|node|/x");
  const ls = tmuxLanes(panes, { seldon_fix: { harness: "codex", startedAt: 5 } });
  assert.deepEqual(ls.map((l) => [l.harness, l.name, l.startedAt]), [["codex", "fix", 5]]);
});
