/**
 * Self-update system for apiary CLI.
 *
 * - `printUpdateNotice()` — sync, reads cache, prints one-liner if update available
 * - `checkForUpdate()`    — async fire-and-forget, compares local/remote HEAD
 * - `runUpdate()`         — the `apiary update` command: git pull + build
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ───────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "../..");
const APIARY_DIR = join(homedir(), ".apiary");
const CACHE_PATH = join(APIARY_DIR, "version-check.json");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ── Cache ───────────────────────────────────────────────────────────────────

interface VersionCache {
  checkedAt: number;
  localHead: string;
  remoteHead: string;
}

function readCache(): VersionCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  try {
    if (!existsSync(APIARY_DIR)) mkdirSync(APIARY_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch { /* best effort */ }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isGitRepo(): boolean {
  return existsSync(join(REPO_ROOT, ".git"));
}

function getLocalHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Print update notice (sync, called on startup) ───────────────────────────

export function printUpdateNotice(): void {
  try {
    const cache = readCache();
    if (!cache) return;
    if (cache.localHead === cache.remoteHead) return;

    const localHead = getLocalHead();
    if (!localHead || localHead === cache.remoteHead) return;

    const v = getLocalVersion();
    console.error(`\x1b[33m  A new version of apiary is available.\x1b[0m \x1b[2m(current: v${v})\x1b[0m`);
    console.error(`\x1b[2m  Run \x1b[36mapiary update\x1b[0m\x1b[2m to upgrade.\x1b[0m\n`);
  } catch { /* never break the CLI */ }
}

// ── Check for update (non-blocking, fire-and-forget) ────────────────────────

export function checkForUpdate(): void {
  try {
    if (!isGitRepo()) return;

    const cache = readCache();
    if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;

    const localHead = getLocalHead();
    if (!localHead) return;

    // Fire off git ls-remote in background
    const child = spawn("git", ["ls-remote", "origin", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) return;
      const remoteHead = stdout.split(/\s/)[0]?.trim();
      if (!remoteHead) return;
      writeCache({ checkedAt: Date.now(), localHead, remoteHead });
    });

    child.unref();
  } catch { /* never break the CLI */ }
}

// ── Run update (the `apiary update` command) ────────────────────────────────

export async function runUpdate(targetVersion?: string): Promise<void> {
  if (!isGitRepo()) {
    console.error("apiary update requires a git checkout.");
    process.exit(1);
  }

  const fromVersion = getLocalVersion();
  const fromHead = getLocalHead();

  console.log(`\x1b[2m  Current version: v${fromVersion}\x1b[0m`);

  if (targetVersion) {
    // Checkout a specific version tag
    const tag = targetVersion.startsWith("v") ? targetVersion : `v${targetVersion}`;
    console.log(`\x1b[36m  Switching to ${tag}...\x1b[0m`);
    try {
      execFileSync("git", ["fetch", "--tags"], { cwd: REPO_ROOT, stdio: "inherit" });
      execFileSync("git", ["checkout", tag], { cwd: REPO_ROOT, stdio: "inherit" });
    } catch {
      console.error(`\n\x1b[31m  Version ${tag} not found.\x1b[0m`);
      process.exit(1);
    }
  } else {
    console.log(`\x1b[36m  Pulling latest...\x1b[0m`);
    try {
      execFileSync("git", ["pull", "--ff-only"], { cwd: REPO_ROOT, stdio: "inherit" });
    } catch {
      console.error("\n\x1b[31m  git pull failed.\x1b[0m Check for uncommitted changes or merge conflicts.");
      process.exit(1);
    }
  }

  // Check if deps changed
  const toHead = getLocalHead();
  if (toHead && fromHead && toHead !== fromHead) {
    try {
      const changed = execFileSync("git", ["diff", `${fromHead}..${toHead}`, "--name-only"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      if (changed.includes("package-lock.json") || changed.includes("package.json")) {
        console.log(`\x1b[36m  Dependencies changed, installing...\x1b[0m`);
        execFileSync("npm", ["install"], { cwd: REPO_ROOT, stdio: "inherit" });
      }
    } catch { /* proceed to build anyway */ }
  }

  console.log(`\x1b[36m  Building...\x1b[0m`);
  try {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    console.error("\n\x1b[31m  Build failed.\x1b[0m");
    process.exit(1);
  }

  const toVersion = getLocalVersion();

  // Clear cache
  try { unlinkSync(CACHE_PATH); } catch { /* fine */ }

  console.log("");
  if (fromVersion !== toVersion) {
    console.log(`\x1b[32m  Updated apiary: v${fromVersion} → v${toVersion}\x1b[0m`);
  } else if (fromHead !== toHead) {
    console.log(`\x1b[32m  Updated apiary to latest (v${toVersion})\x1b[0m`);
  } else {
    console.log(`\x1b[33m  Already up to date (v${fromVersion})\x1b[0m`);
  }
}
