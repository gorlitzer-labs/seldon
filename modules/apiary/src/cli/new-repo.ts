/**
 * Create the directory an agent is about to work in.
 *
 * The wizard let you *type* a path but never created it, and
 * `spawnAgentBackground` silently returned false for a directory that did not
 * exist — so naming a repo you had not made yet produced an agent that never
 * appeared, with nothing printed to say why. Starting a room for a project
 * that does not exist yet is a completely reasonable thing to want.
 *
 * `git init` is offered because apiary's own default room rules tell agents
 * "never push to main, open a PR" and "no force-push, no git reset --hard" —
 * instructions that mean nothing outside a repo.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

/**
 * Ceiling on the git subprocesses here. Generous for the work (init and
 * rev-parse are milliseconds) and short enough that a misconfigured machine
 * fails loudly instead of wedging the wizard.
 */
const GIT_TIMEOUT_MS = 15_000;

export type CreateRepoOutcome =
  | { ok: true; created: boolean; gitInitialised: boolean }
  | { ok: false; error: string };

/** True if `dir` is inside a git work tree (its own, or an ancestor's). */
export function isInsideGitRepo(dir: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      // execFileSync blocks the event loop, so a git that waits on something
      // (a credential or editor prompt on a machine configured differently)
      // hangs the whole process — and in a test run nothing can interrupt it,
      // because a synchronous hang never trips vitest's own timeout.
      timeout: GIT_TIMEOUT_MS,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** True if the directory exists and has something in it. */
export function isNonEmptyDir(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure `dir` exists, optionally initialising a git repo in it.
 *
 * `git init` is skipped when the directory is already inside a work tree —
 * creating a nested repo inside an existing one is almost never what someone
 * means, and it quietly breaks the outer repo's view of those files.
 */
export function createRepoDir(
  dir: string,
  opts?: { gitInit?: boolean },
): CreateRepoOutcome {
  let created = false;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
  } catch (err) {
    return { ok: false, error: `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!opts?.gitInit) return { ok: true, created, gitInitialised: false };

  // Covers both "already a repo" and "inside someone else's repo". Nesting a
  // repo inside an existing work tree silently removes those files from the
  // outer repo's control, which is never what "git init" is meant to do here.
  if (isInsideGitRepo(dir)) return { ok: true, created, gitInitialised: false };

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    return { ok: true, created, gitInitialised: true };
  } catch {
    // A directory without a repo still works; the agent just cannot open PRs.
    return { ok: true, created, gitInitialised: false };
  }
}
