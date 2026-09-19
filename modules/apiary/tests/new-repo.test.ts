/**
 * Tests for creating the directory an agent will work in.
 *
 * The wizard accepted a typed path but never created it, and the agent spawn
 * then failed silently — no agent, no message. Starting a room for a project
 * that does not exist yet is a reasonable thing to want, so it now works; the
 * care here is about not damaging anything that already exists.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { createRepoDir, isInsideGitRepo, isNonEmptyDir } from "../src/cli/new-repo.js";

let base: string;

beforeEach(() => { base = mkdtempSync(join(tmpdir(), "apiary_newrepo_")); });
afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ } });

describe("createRepoDir", () => {
  test("creates a missing directory, including parents", () => {
    const target = join(base, "a", "b", "my-thing");
    expect(createRepoDir(target)).toMatchObject({ ok: true, created: true });
    expect(existsSync(target)).toBe(true);
  });

  test("git init when asked", () => {
    const target = join(base, "proj");
    expect(createRepoDir(target, { gitInit: true }))
      .toMatchObject({ ok: true, created: true, gitInitialised: true });
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  test("no git repo unless asked", () => {
    const target = join(base, "proj");
    createRepoDir(target);
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  test("an existing directory is reported as existing, not created", () => {
    const target = join(base, "already");
    mkdirSync(target);
    expect(createRepoDir(target)).toMatchObject({ ok: true, created: false });
  });

  test("NEVER touches files already in the directory", () => {
    const target = join(base, "has-stuff");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "precious");

    createRepoDir(target, { gitInit: true });
    expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("precious");
  });

  test("does not re-init an existing repo", () => {
    const target = join(base, "repo");
    mkdirSync(target);
    execFileSync("git", ["init", "--quiet"], { cwd: target, stdio: "ignore" });
    writeFileSync(join(target, "f.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: target, stdio: "ignore" });

    const res = createRepoDir(target, { gitInit: true });
    // Re-initialising is mostly harmless but claiming we did it would be a lie.
    expect(res).toMatchObject({ ok: true, gitInitialised: false });
    // And the staged file is still staged.
    const status = execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf-8" });
    expect(status).toContain("f.txt");
  });

  test("does not nest a repo inside an existing work tree", () => {
    // A nested repo silently removes those files from the outer repo's
    // control, which is almost never what someone means by "git init".
    const outer = join(base, "outer");
    mkdirSync(outer);
    execFileSync("git", ["init", "--quiet"], { cwd: outer, stdio: "ignore" });

    const inner = join(outer, "packages", "thing");
    const res = createRepoDir(inner, { gitInit: true });

    expect(res).toMatchObject({ ok: true, created: true, gitInitialised: false });
    expect(existsSync(join(inner, ".git"))).toBe(false);
  });

  test("an impossible location is reported, not thrown", () => {
    // A path *through* a regular file: mkdir gives ENOTDIR on every platform,
    // so the assertion is unconditional. The previous version pointed at
    // /proc, which does not exist on macOS, behaves differently as root, and
    // could only be asserted behind `if (!res.ok)` — a test that passes when
    // it proves nothing.
    const file = join(base, "a-file");
    writeFileSync(file, "x");

    const res = createRepoDir(join(file, "nested"), { gitInit: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("could not create");
  });
});

describe("isInsideGitRepo", () => {
  test("true inside a repo, false outside", () => {
    const repo = join(base, "r");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
    expect(isInsideGitRepo(repo)).toBe(true);

    const plain = join(base, "plain");
    mkdirSync(plain);
    // /tmp is not inside a repo; a nonexistent path must not throw either.
    expect(isInsideGitRepo(join(base, "nope"))).toBe(false);
  });
});

describe("isNonEmptyDir", () => {
  test("distinguishes empty, non-empty and missing", () => {
    const empty = join(base, "e");
    mkdirSync(empty);
    expect(isNonEmptyDir(empty)).toBe(false);

    writeFileSync(join(empty, "f"), "x");
    expect(isNonEmptyDir(empty)).toBe(true);

    expect(isNonEmptyDir(join(base, "missing"))).toBe(false);
  });
});
