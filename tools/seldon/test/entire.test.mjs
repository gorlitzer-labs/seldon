/**
 * entire.mjs: turning Entire on for a project, and reading back per lane which commits it
 * recorded. The log fixture is real `git log --format=LOG_FORMAT` output; the last block
 * runs `seldon lane why` against a real worktree with a stand-in `entire` on PATH.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCheckpointLog, enableSteps, laneRange, LOG_FORMAT, TRAILER } from "../lib/entire.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "seldon.js");
const US = "\x1f";

describe("parseCheckpointLog", () => {
  test("keeps the commits that carry a checkpoint, newest first, and drops the rest", () => {
    const out = [
      `487e025${US}berlin fog${US}01M611RMPA419ST8CQEDJHMKBW`,
      `1111111${US}a hand-made commit${US}`,
      `deec3ce${US}paris clouds${US}01M611E260C7ZNZZVRJEVHZP0P`,
    ].join("\n") + "\n";
    assert.deepEqual(parseCheckpointLog(out), [
      { sha: "487e025", subject: "berlin fog", ids: ["01M611RMPA419ST8CQEDJHMKBW"] },
      { sha: "deec3ce", subject: "paris clouds", ids: ["01M611E260C7ZNZZVRJEVHZP0P"] },
    ]);
  });

  test("a commit linked to two sessions lists both", () => {
    assert.deepEqual(parseCheckpointLog(`abc${US}merge work${US}AAA,BBB`)[0].ids, ["AAA", "BBB"]);
  });

  test("nothing in, nothing out", () => {
    assert.deepEqual(parseCheckpointLog(""), []);
    assert.deepEqual(parseCheckpointLog(undefined), []);
  });
});

describe("enableSteps", () => {
  test("claude first, then one agent add per other harness; telemetry off; checkpoints to the named remote", () => {
    const steps = enableSteps({ remote: "private", harnesses: ["claude", "codex", "opencode"] });
    assert.deepEqual(steps, [
      ["entire", ["enable", "--agent", "claude-code", "--telemetry=false", "--checkpoint-push-remote", "private"]],
      ["entire", ["agent", "add", "codex"]],
      ["entire", ["agent", "add", "opencode"]],
    ]);
  });

  test("defaults to origin, and ignores harnesses Entire has no name for", () => {
    const steps = enableSteps({ harnesses: ["claude", "mystery"] });
    assert.equal(steps.length, 1);
    assert.ok(steps[0][1].includes("origin"));
  });
});

describe("laneRange", () => {
  test("against the project's default branch, as the remote names it", () => {
    assert.equal(laneRange("origin/trunk\n"), "origin/trunk..HEAD");
  });
  test("a clone with no remote HEAD falls back to main", () => {
    assert.equal(laneRange(""), "main..HEAD");
    assert.equal(laneRange("origin/HEAD"), "main..HEAD");
  });
});

describe("seldon lane why, on a real worktree", () => {
  let dir, repo, wt, home, bin, env;
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const commit = (cwd, file, msg) => { writeFileSync(path.join(cwd, file), msg); git(["add", "-A"], cwd); git(["commit", "-qm", msg], cwd); };

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "seldon-entire-"));
    repo = path.join(dir, "weather"); wt = path.join(dir, "lane-paris"); home = path.join(dir, "seldon-home"); bin = path.join(dir, "bin");
    mkdirSync(repo); mkdirSync(home); mkdirSync(bin);
    // A stand-in `entire`: says what it was asked, so the test can see which checkpoint.
    writeFileSync(path.join(bin, "entire"), '#!/bin/sh\necho "ENTIRE $*"\n'); chmodSync(path.join(bin, "entire"), 0o755);
    env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, SELDON_HOME: home,
      GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ana", GIT_AUTHOR_EMAIL: "ana@users.noreply.github.com",
      GIT_COMMITTER_NAME: "ana", GIT_COMMITTER_EMAIL: "ana@users.noreply.github.com",
    };
    git(["init", "-q", "-b", "main"]);
    commit(repo, "README.md", "weather cli");
    git(["commit", "-q", "--amend", "-m", `weather cli\n\n${TRAILER}: 01MAIN`]);
    git(["worktree", "add", "-q", "-b", "lane/paris", wt]);
    commit(wt, "paris.txt", "paris clouds");
    git(["commit", "-q", "--amend", "-m", `paris clouds\n\n${TRAILER}: 01PARIS`], wt);
    commit(wt, "notes.txt", "hand edit");
    writeFileSync(path.join(wt, "fog.txt"), "berlin fog"); git(["add", "-A"], wt);
    git(["commit", "-q", "-m", `berlin fog\n\n${TRAILER}: 01BERLIN`], wt);
    // A lane seldon started whose tmux session is gone: listed as stopped, with its worktree.
    const session = `seldon_why-test-${process.pid}`;
    writeFileSync(path.join(home, "lanes.json"), JSON.stringify([{ session, harness: "codex", slug: `why-test-${process.pid}`, task: "paris", root: repo, worktree: wt, startedAt: 1 }]));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const why = () => spawnSync("node", [BIN, "lane", "why", `why-test-${process.pid}`], { env, encoding: "utf8" });

  test("lists only the lane's recorded commits, then explains the newest", () => {
    const r = why();
    const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(out, /2 recorded commit\(s\)/);
    assert.match(out, /berlin fog\s+01BERLIN/);
    assert.match(out, /paris clouds\s+01PARIS/);
    assert.doesNotMatch(out, /hand edit/, "a commit without a checkpoint is not listed");
    assert.doesNotMatch(out, /weather cli|01MAIN/, "main's own recorded history is not the lane's");
    assert.match(out, /ENTIRE checkpoint explain 01BERLIN/, "the newest is explained");
  });

  test("the log format is the one the parser reads", () => {
    const parsed = parseCheckpointLog(git(["log", "main..HEAD", `--format=${LOG_FORMAT}`], wt));
    assert.deepEqual(parsed.map((c) => c.ids[0]), ["01BERLIN", "01PARIS"]);
  });
});
