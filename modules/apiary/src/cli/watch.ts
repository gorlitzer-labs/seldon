/**
 * Agent watcher — open an agent's tmux session in a NEW terminal window.
 *
 * Deliberately a second tmux client on the agent's existing session, in its
 * own window: the room TUI keeps running untouched and stays usable, no pane
 * moves, no session is destroyed. (`tmux join-pane` would pull the agent's
 * pane into the room's window, but moving the last pane out of a session
 * destroys that session — and the bridges address agents by session name, so
 * event delivery would silently die.)
 *
 * Two things this has to get right, both found the hard way:
 *
 *   1. Terminals launch the command WITHOUT a login shell, so `tmux` is not
 *      on PATH — the window opens and instantly dies. Always pass an absolute
 *      path.
 *   2. Attaching resizes the session to the newest client, read-only clients
 *      included, which reflows the pane the bridges pattern-match on. Agent
 *      sessions are created with `window-size manual` (see tmux.ts) so this
 *      cannot happen; watchers letterbox instead.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Where tmux actually lives. Terminals get no login shell, so PATH is not enough. */
export function resolveTmuxPath(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const found = execFileSync("which", ["tmux"], { encoding: "utf-8", env }).trim();
    if (found) return found;
  } catch {
    /* fall through to the usual suspects */
  }
  for (const candidate of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type TerminalKind = "iterm" | "apple-terminal" | "ghostty" | "wezterm" | "kitty" | "alacritty";

/** A terminal we know how to open a new window in, and how. */
export interface TerminalLauncher {
  kind: TerminalKind;
  /** True if this terminal is usable on this machine. */
  available(env: NodeJS.ProcessEnv): boolean;
  /** argv that opens a new window running `command`. */
  argv(command: string): string[];
}

/** Quote for AppleScript's double-quoted string literals. */
function osaQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Known terminals, in fallback order. Exported so tests can inject their own
 * table — availability here probes the real filesystem, and a test asserting
 * "some terminal exists on this machine" passes on a laptop and fails on a
 * Linux CI runner, which says nothing about the selection logic.
 */
export const LAUNCHERS: TerminalLauncher[] = [
  {
    kind: "iterm",
    available: (env) => env.TERM_PROGRAM === "iTerm.app" || existsSync("/Applications/iTerm.app"),
    argv: (command) => ["osascript", "-e",
      `tell application "iTerm"\n  create window with default profile command "${osaQuote(command)}"\n  activate\nend tell`,
    ],
  },
  {
    kind: "ghostty",
    available: (env) => env.TERM_PROGRAM === "ghostty" || existsSync("/Applications/Ghostty.app"),
    argv: (command) => ["open", "-na", "Ghostty", "--args", "-e", command],
  },
  {
    kind: "wezterm",
    available: () => commandExists("wezterm"),
    argv: (command) => ["wezterm", "start", "--", "sh", "-c", command],
  },
  {
    kind: "kitty",
    available: () => commandExists("kitty"),
    argv: (command) => ["kitty", "sh", "-c", command],
  },
  {
    kind: "alacritty",
    available: () => commandExists("alacritty"),
    argv: (command) => ["alacritty", "-e", "sh", "-c", command],
  },
  {
    // Last resort: every mac has it, but it steals focus and ignores profiles.
    kind: "apple-terminal",
    available: () => existsSync("/System/Applications/Utilities/Terminal.app")
      || existsSync("/Applications/Utilities/Terminal.app"),
    argv: (command) => ["osascript", "-e",
      `tell application "Terminal"\n  do script "${osaQuote(command)}"\n  activate\nend tell`,
    ],
  },
];

function commandExists(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a terminal to open. Prefers the one the user is already in, so the
 * watcher window matches their theme and font, then falls back down the list.
 */
export function pickTerminal(
  env: NodeJS.ProcessEnv = process.env,
  launchers: readonly TerminalLauncher[] = LAUNCHERS,
): TerminalLauncher | null {
  const current = launchers.find((l) => l.kind === terminalFromEnv(env));
  if (current?.available(env)) return current;
  return launchers.find((l) => l.available(env)) ?? null;
}

/** The launcher for one terminal, regardless of whether it is installed. */
export function launcherFor(kind: TerminalKind): TerminalLauncher {
  const found = LAUNCHERS.find((l) => l.kind === kind);
  if (!found) throw new Error(`no launcher for ${kind}`);
  return found;
}

/** The terminal apiary is currently running inside, if we recognise it. */
export function terminalFromEnv(env: NodeJS.ProcessEnv = process.env): TerminalKind | null {
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":       return "iterm";
    case "Apple_Terminal":  return "apple-terminal";
    case "ghostty":         return "ghostty";
    case "WezTerm":         return "wezterm";
    default:                break;
  }
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.ALACRITTY_WINDOW_ID) return "alacritty";
  return null;
}

/**
 * The tmux command a watcher window runs.
 *
 * Read-only by default: a stray keystroke in an agent's pane types into its
 * composer and submits whatever was there. `control` gives a writable client
 * for when you actually mean to drive it.
 */
export function watchCommand(
  tmuxPath: string,
  tmuxSession: string,
  opts?: { control?: boolean },
): string {
  const flags = opts?.control ? ["attach"] : ["attach", "-r"];
  return [tmuxPath, ...flags, "-t", tmuxSession].join(" ");
}

export type WatchOutcome =
  | { ok: true; terminal: TerminalKind; readOnly: boolean }
  | { ok: false; reason: string };

/**
 * Open a new terminal window watching `tmuxSession`.
 *
 * Never throws and never blocks: the child is detached and unref'd so the room
 * TUI carries on regardless of what the terminal does.
 */
export function openAgentWatcher(
  tmuxSession: string,
  opts?: { control?: boolean; env?: NodeJS.ProcessEnv },
): WatchOutcome {
  const env = opts?.env ?? process.env;

  const tmuxPath = resolveTmuxPath(env);
  if (!tmuxPath) return { ok: false, reason: "tmux not found" };

  const launcher = pickTerminal(env);
  if (!launcher) return { ok: false, reason: "no supported terminal found" };

  const [bin, ...args] = launcher.argv(watchCommand(tmuxPath, tmuxSession, opts));

  try {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    return { ok: false, reason: `could not launch ${launcher.kind}` };
  }

  return { ok: true, terminal: launcher.kind, readOnly: !opts?.control };
}
