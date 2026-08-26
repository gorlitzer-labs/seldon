/**
 * Interactive prompts for the `apiary room create` wizard:
 *   - `askRepoPath` — repo path picker (current dir + recents + discovered git repos + custom)
 *   - `askRuntime`  — claude / codex (driven by detected runtimes)
 *
 * All three share a generic arrow-key picker primitive (`pickFromList`) that
 * falls back to plain text input when stdin isn't a TTY or the user hits ESC.
 */

import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin, resolve } from "node:path";

const APIARY_DIR = pathJoin(homedir(), ".apiary");
const RECENT_PATH = pathJoin(APIARY_DIR, "recent_repos.json");
const MAX_RECENT = 10;
const MAX_VISIBLE = 12;
const SCAN_ROOTS = ["", "Desktop", "code", "Projects", "dev", "src", "work", "repos"];

const KEY_CTRL_C = "\u0003";
const KEY_ESC = "\u001b";
const KEY_ESC_ALT = "\u001b\u001b";
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = "\x1b[36m";  // cyan
const D = "\x1b[2m";   // dim
const B = "\x1b[1m";   // bold
const G = "\x1b[32m";  // green
const Y = "\x1b[33m";  // yellow
const M = "\x1b[35m";  // magenta
const R = "\x1b[0m";

// ── Path utilities ────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return pathJoin(homedir(), p.slice(2));
  return p;
}

function isGitRepo(p: string): boolean {
  try {
    const s = statSync(pathJoin(p, ".git"));
    return s.isDirectory() || s.isFile(); // .git can be a file (worktrees, submodules)
  } catch {
    return false;
  }
}

export function shortenPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

// ── Recent-repos persistence ──────────────────────────────────────────────────

function loadRecent(): string[] {
  try {
    const data = JSON.parse(readFileSync(RECENT_PATH, "utf-8")) as { paths?: unknown };
    return Array.isArray(data.paths)
      ? data.paths.filter((p): p is string => typeof p === "string" && existsSync(p))
      : [];
  } catch {
    return [];
  }
}

export function recordRecentRepo(path: string): void {
  const resolved = resolve(path);
  const existing = loadRecent().filter((p) => p !== resolved);
  const next = [resolved, ...existing].slice(0, MAX_RECENT);
  try {
    if (!existsSync(APIARY_DIR)) mkdirSync(APIARY_DIR, { recursive: true });
    writeFileSync(RECENT_PATH, JSON.stringify({ paths: next }, null, 2));
  } catch {
    /* non-fatal */
  }
}

function discoverRepos(): string[] {
  const found: string[] = [];
  const home = homedir();
  for (const sub of SCAN_ROOTS) {
    const root = sub ? pathJoin(home, sub) : home;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = pathJoin(root, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
        if (isGitRepo(full)) found.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return found;
}

// ── Generic arrow-key picker ──────────────────────────────────────────────────

export interface PickerItem<T> {
  label: string;
  value: T;
  hint?: string;
}

const CUSTOM = Symbol("custom");

function arrowPicker<T>(
  items: PickerItem<T | typeof CUSTOM>[],
  header: string,
  escHint: string,
): Promise<PickerItem<T | typeof CUSTOM> | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let idx = 0;
    let printed = 0;
    const visible = Math.min(items.length, MAX_VISIBLE);

    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const render = () => {
      if (printed > 0) stdout.write(`\x1b[${printed}A\r`);
      stdout.write("\x1b[J");
      stdout.write(header + "\n");
      const start = Math.max(0, Math.min(idx - Math.floor(visible / 2), items.length - visible));
      const end = Math.min(start + visible, items.length);
      for (let i = start; i < end; i++) {
        const it = items[i];
        const isCursor = i === idx;
        const marker = isCursor ? `${Y}❯${R}` : " ";
        const label = isCursor ? `${C}${B}${it.label}${R}` : it.label;
        const hint = it.hint ? `  ${D}${it.hint}${R}` : "";
        stdout.write(`    ${marker} ${label}${hint}\n`);
      }
      const more = items.length > visible
        ? `    ${D}(${items.length} options — ↑/↓ scrolls)${R}\n`
        : "";
      stdout.write(more);
      stdout.write(`    ${D}↑/↓ navigate · enter select · esc ${escHint}${R}\n`);
      printed = (end - start) + 1 + (more ? 1 : 0) + 1;
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (key: string) => {
      if (key === KEY_CTRL_C) {
        cleanup();
        process.exit(130);
      }
      if (key === KEY_ESC || key === KEY_ESC_ALT) {
        cleanup();
        stdout.write("\n");
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(items[idx]);
        return;
      }
      if (key === KEY_UP || key === "k") {
        idx = (idx - 1 + items.length) % items.length;
        render();
        return;
      }
      if (key === KEY_DOWN || key === "j") {
        idx = (idx + 1) % items.length;
        render();
        return;
      }
    };

    stdin.on("data", onData);
    render();
  });
}

type Asker = (q: string) => Promise<string>;

// ── askRepoPath ───────────────────────────────────────────────────────────────

export interface AskRepoPathOpts {
  alias: string;
  defaultPath: string;
  ask: Asker;
}

export async function askRepoPath(opts: AskRepoPathOpts): Promise<string> {
  const cwd = resolve(opts.defaultPath);
  const recent = loadRecent();
  const discovered = discoverRepos();

  const seen = new Set<string>();
  const items: PickerItem<string | typeof CUSTOM>[] = [];
  const add = (path: string, hint?: string) => {
    const r = resolve(path);
    if (seen.has(r)) return;
    seen.add(r);
    items.push({ label: shortenPath(r), value: r, hint });
  };

  add(cwd, "current dir");
  for (const p of recent) add(p, "recent");
  for (const p of discovered) add(p);

  items.push({ label: `${M}✎${R}  Type a custom path…`, value: CUSTOM });

  const header = `    📁 ${B}Repo${R} ${D}for ${opts.alias}${R}`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const typed = await opts.ask(`    Repo path ${D}[${shortenPath(cwd)}]${R}: `);
    const final = typed ? resolve(expandTilde(typed)) : cwd;
    recordRecentRepo(final);
    return final;
  }

  const picked = await arrowPicker(items, header, "to type a path");

  let final: string;
  if (!picked || picked.value === CUSTOM) {
    const typed = await opts.ask(`    Custom repo path ${D}[${shortenPath(cwd)}]${R}: `);
    final = typed ? resolve(expandTilde(typed)) : cwd;
  } else {
    final = picked.value as string;
  }

  recordRecentRepo(final);
  return final;
}

// ── askRuntime ────────────────────────────────────────────────────────────────

export interface AskRuntimeOpts {
  alias: string;
  available: string[]; // subset of ["claude", "codex"]
  ask: Asker;
}

const RUNTIME_HINTS: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex CLI",
};

export async function askRuntime(opts: AskRuntimeOpts): Promise<string | undefined> {
  if (opts.available.length === 0) return undefined;
  if (opts.available.length === 1) return opts.available[0];

  const runtimeGlyph: Record<string, string> = { claude: "🧠", codex: "⌨️ " };
  const items: PickerItem<string | typeof CUSTOM>[] = opts.available.map((rt) => ({
    label: `${runtimeGlyph[rt] ?? "⚙️ "} ${rt}`,
    value: rt,
    hint: RUNTIME_HINTS[rt],
  }));
  const header = `    ⚙️  ${B}Runtime${R} ${D}for ${opts.alias}${R}`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const typed = (await opts.ask(`    Runtime ${D}[claude]${R} ${D}(${opts.available.join("/")})${R}: `)) || "claude";
    return opts.available.includes(typed) ? typed : "claude";
  }

  const picked = await arrowPicker(items, header, "to skip");
  return picked ? (picked.value as string) : opts.available[0];
}
