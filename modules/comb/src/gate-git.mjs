/**
 * The gate's contact with git: which commits a push would publish, what is in
 * them, and the hook that runs the check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { SEP, parseLog } from "./gate.mjs";

const ZERO = /^0+$/;

function git(args, { cwd, input } = {}) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr?.trim() || "failed"}`);
  return r.stdout;
}

/**
 * Turn a pre-push hook's stdin into `git rev-list` arguments.
 *
 * Each line is `<local ref> <local sha> <remote ref> <remote sha>`. What gets
 * published is every commit reachable from the local sha that the remote does
 * not already have. `--not --remotes` rather than `<remote sha>..<local sha>`:
 * the remote sha is all zeros for a new branch, and a brand-new repository has
 * no remote refs at all — in which case the whole history is about to be
 * published, and the whole history is what gets checked.
 */
export function pushRange(stdin) {
  const tips = [];
  for (const line of stdin.split("\n")) {
    const [, localSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // a branch deletion publishes nothing
    tips.push(localSha);
  }
  return tips.length ? [...tips, "--not", "--remotes"] : null;
}

/** Everything a set of rev-list arguments covers, parsed for the gate. */
export function readCommits(revArgs, cwd) {
  const out = git([
    "log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    `--format=${SEP}%H%x1f%an%x1f%ae%x1f%cn%x1f%ce`, ...revArgs,
  ], { cwd });
  return parseLog(out);
}

/** The repo's `.combgateignore`, from the working tree (the ignore rules you have now). */
export function readIgnoreFile(cwd) {
  const p = join(git(["rev-parse", "--show-toplevel"], { cwd }).trim(), ".combgateignore");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/**
 * Run gitleaks over the same commits, when it is installed.
 *
 * It knows hundreds of credential formats this module never will, so it is
 * worth having; it is not required, because the rules that caught the worst of
 * the real leaks (identity, geolocation, network scans) are not its job.
 * Returns null when gitleaks is absent, so the caller can say so.
 */
export function gitleaks(revArgs, cwd) {
  if (spawnSync("gitleaks", ["version"], { encoding: "utf-8" }).status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "comb-gate-"));
  const report = join(dir, "report.json");
  try {
    spawnSync("gitleaks", [
      "git", "--no-banner", "--redact", "--exit-code", "0",
      "--log-opts", revArgs.join(" "), "--report-format", "json", "--report-path", report, ".",
    ], { cwd, encoding: "utf-8" });
    const found = existsSync(report) ? JSON.parse(readFileSync(report, "utf-8") || "[]") : [];
    return found.map((f) => ({
      sha: f.Commit, where: `${f.File}:${f.StartLine}`, rule: "gitleaks", why: f.Description || f.RuleID,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The hook. Plain sh so it runs wherever git does.
 *
 * It keeps the push's stdin, because git hands the ref list to the hook once
 * and both the gate and any project hook after it need it. If the repository
 * has its own pre-push (in .git/hooks, which a global hooks path otherwise
 * silences), that runs next, so installing the gate never disables a project's
 * own checks.
 *
 * Fails closed: if comb cannot be found the push is blocked, not waved
 * through. A gate that opens whenever its tool is missing protects nothing on
 * exactly the machine that has not been set up yet.
 */
export const MARK = "# comb gate";
export function hookScript() {
  return `#!/bin/sh
${MARK} — blocks pushes that would publish secrets or personal details.
# Bypass for one push, deliberately: git push --no-verify
input=$(cat)
if ! command -v comb >/dev/null 2>&1; then
  echo "comb gate: 'comb' is not on PATH, so this push was not checked. Blocked." >&2
  echo "           install @gorlitzer-labs/comb, or bypass once with: git push --no-verify" >&2
  exit 1
fi
printf '%s\\n' "$input" | comb gate check --hook "$@" || exit 1
own="$(git rev-parse --git-dir)/hooks/pre-push"
if [ -x "$own" ] && [ "$(cd "$(dirname "$own")" && pwd -P)/pre-push" != "$(cd "$(dirname "$0")" && pwd -P)/pre-push" ]; then
  printf '%s\\n' "$input" | "$own" "$@"
fi
`;
}

export const globalHooksDir = () => join(process.env.COMB_HOME ?? join(homedir(), ".comb"), "hooks");

/**
 * Install the hook for every repository on this machine.
 *
 * A global `core.hooksPath`. One caveat it cannot fix from here: a repository
 * that sets its own `core.hooksPath` (husky does) overrides the global one, and
 * git then never looks at ours. `status` reports that case; `install` inside
 * such a repository adds the gate to its hooks directory instead.
 */
export function installGlobal() {
  const dir = globalHooksDir();
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, hookScript());
  chmodSync(hook, 0o755);
  const prev = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], { encoding: "utf-8" }).stdout.trim();
  git(["config", "--global", "core.hooksPath", dir]);
  return { hook, prev: prev && resolve(prev) !== resolve(dir) ? prev : null };
}

/** Install into one repository's effective hooks directory. */
export function installRepo(cwd) {
  const dir = resolve(cwd, git(["rev-parse", "--git-path", "hooks"], { cwd }).trim());
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  if (existsSync(hook)) {
    const cur = readFileSync(hook, "utf-8");
    if (cur.includes(MARK)) return { hook, already: true };
    // Someone else's hook (husky, a project script): run the gate first, then it.
    const line = `\n${MARK}\ninput=$(cat)\nprintf '%s\\n' "$input" | comb gate check --hook "$@" || exit 1\n`;
    throw Object.assign(new Error(
      `${hook} already exists and is not the gate's. Add this at its top, and have anything below that reads stdin read "$input" instead:${line}`), { hook });
  }
  writeFileSync(hook, hookScript());
  chmodSync(hook, 0o755);
  return { hook, already: false };
}

/** Whether a push from this repository would actually go through the gate. */
export function status(cwd) {
  const local = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd, encoding: "utf-8" }).stdout.trim();
  const global = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], { encoding: "utf-8" }).stdout.trim();
  const dir = resolve(cwd, git(["rev-parse", "--git-path", "hooks"], { cwd }).trim());
  const hook = join(dir, "pre-push");
  const guarded = existsSync(hook) && readFileSync(hook, "utf-8").includes("comb gate check");
  return { guarded, hook, local: local || null, global: global || null };
}
