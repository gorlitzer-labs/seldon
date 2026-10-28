/**
 * `seldon lane rm` — a done lane's worktree goes, its branch only when git sees it merged.
 * Pure rules first, then removeLane against a real git repo under a sandboxed SELDON_HOME.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { removeCommands } from "../lib/lanes.mjs";

const stopped = (o) => ({ harness: "codex", state: "stopped", cwd: "/w/fix", ...o });

describe("rules", () => {
  test("only a stopped or failed lane can go", () => {
    for (const state of ["working", "running", "needs-you", "idle"]) assert.match(removeCommands(stopped({ state }), { root: "/r" }).why, /stop it first/);
    assert.ok(removeCommands(stopped({ state: "failed" }), { root: "/r" }).cmds);
  });

  test("never removes the repo itself", () => {
    assert.match(removeCommands(stopped({ cwd: "/r/" }), { root: "/r" }).why, /repo itself/);
    assert.ok(removeCommands(stopped(), { root: null }).why);
  });

  test("uncommitted work is kept unless --force", () => {
    assert.match(removeCommands(stopped(), { root: "/r", dirty: true }).why, /uncommitted/);
    assert.deepEqual(removeCommands(stopped(), { root: "/r", dirty: true, force: true }).cmds[0].args, ["-C", "/r", "worktree", "remove", "--force", "/w/fix"]);
  });

  test("the branch goes with -d (merged only), never -D; a detached HEAD has none", () => {
    const how = removeCommands(stopped(), { root: "/r", branch: "lane/fix" });
    assert.deepEqual(how.cmds[0].args, ["-C", "/r", "worktree", "remove", "/w/fix"]);
    assert.deepEqual(how.branch.args, ["-C", "/r", "branch", "-d", "lane/fix"]);
    assert.equal(removeCommands(stopped(), { root: "/r", branch: "HEAD" }).branch, null);
  });
});

describe("removeLane on a real repo", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "seldon-rm-")));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  process.env.SELDON_HOME = join(tmp, "home");
  const root = join(tmp, "repo");
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const lane = (slug) => {
    const wt = join(tmp, "wt", slug);
    git("worktree", "add", "-q", "-b", `lane/${slug}`, wt);
    return { harness: "codex", state: "stopped", cwd: wt, name: slug, tmuxSession: `seldon_${slug}` };
  };
  const branches = () => git("branch", "--format=%(refname:short)").split("\n");

  test("merged: worktree, branch and registry entry all go", async () => {
    const { removeLane } = await import("../lib/actions.mjs");
    const { recordLane } = await import("../lib/agents.mjs");
    const l = lane("merged");
    recordLane({ session: l.tmuxSession, harness: "codex", worktree: l.cwd });
    recordLane({ session: "seldon_other", harness: "codex", worktree: "/x" });
    const r = removeLane(l);
    assert.deepEqual([r.ok, r.branch, r.branchDeleted], [true, "lane/merged", true]);
    assert.ok(!existsSync(l.cwd));
    assert.ok(!branches().includes("lane/merged"));
    const left = JSON.parse(readFileSync(join(process.env.SELDON_HOME, "lanes.json"), "utf8")).map((e) => e.session);
    assert.deepEqual(left, ["seldon_other"]);
  });

  test("unmerged work: worktree goes, branch and its commit stay", async () => {
    const { removeLane } = await import("../lib/actions.mjs");
    const l = lane("unmerged");
    execFileSync("git", ["-C", l.cwd, "commit", "-q", "--allow-empty", "-m", "work"]);
    const r = removeLane(l);
    assert.deepEqual([r.ok, r.branchDeleted], [true, false]);
    assert.ok(!existsSync(l.cwd));
    assert.ok(branches().includes("lane/unmerged"));
  });

  test("uncommitted changes refuse, --force removes", async () => {
    const { removeLane } = await import("../lib/actions.mjs");
    const l = lane("dirty");
    writeFileSync(join(l.cwd, "wip.txt"), "x");
    assert.match(removeLane(l).why, /uncommitted/);
    assert.ok(existsSync(join(l.cwd, "wip.txt")));
    assert.equal(removeLane(l, { force: true }).ok, true);
    assert.ok(!existsSync(l.cwd));
  });
});
