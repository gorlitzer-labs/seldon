/**
 * tmux helpers for apiary CLI.
 *
 * Thin wrappers around tmux commands. Used by the server process to
 * inject room events into Claude Code sessions.
 */

import { execFileSync, spawn } from "node:child_process";

/** Sanitize a string for use as a tmux session name. Replaces tmux-special chars. */
function sanitizeSessionName(name: string): string {
  return name.replace(/[.:$%]/g, "_");
}

/** Check if tmux is installed and available. */
export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists. */
export function tmuxSessionExists(session: string): boolean {
  try {
    const name = sanitizeSessionName(session);
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Geometry for agent sessions.
 *
 * A detached tmux session defaults to 80x24, which is cramped for either
 * agent CLI — and, more importantly, the bridges decide what an agent is
 * doing by pattern-matching `capture-pane` output. Narrow panes wrap text
 * mid-pattern, so the geometry is a correctness input, not a cosmetic one.
 */
export const AGENT_PANE_COLS = 200;
export const AGENT_PANE_ROWS = 50;

/**
 * Create a detached tmux session with no status bar. Optionally set the
 * terminal tab title.
 *
 * The size is pinned with `window-size manual`. Without it tmux resizes a
 * session to fit whichever client attached most recently, so merely opening a
 * window to watch an agent reflows its pane — 200x50 down to an 80x24
 * terminal's size — and the bridge's screen patterns start missing. Read-only
 * clients resize too, so `attach -r` is not protection.
 */
export function tmuxCreateSession(
  session: string,
  title?: string,
  size: { cols: number; rows: number } = { cols: AGENT_PANE_COLS, rows: AGENT_PANE_ROWS },
): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", [
    "new-session", "-d", "-s", name,
    "-x", String(size.cols), "-y", String(size.rows),
  ]);
  execFileSync("tmux", ["set", "-t", name, "status", "off"]);
  // Pin the geometry so an attaching watcher cannot reflow the agent's pane.
  try {
    execFileSync("tmux", ["set-option", "-t", name, "window-size", "manual"]);
    execFileSync("tmux", ["resize-window", "-t", name, "-x", String(size.cols), "-y", String(size.rows)]);
  } catch {
    // tmux < 3.1 has no window-size option; the agent still runs, it just
    // reflows when watched.
  }
  if (title) {
    execFileSync("tmux", ["set", "-t", name, "set-titles", "on"]);
    execFileSync("tmux", ["set", "-t", name, "set-titles-string", title]);
  }
}

/** Send a command to a tmux session (types it + presses Enter). */
export function tmuxSendCommand(session: string, command: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "-l", command]);
  execFileSync("tmux", ["send-keys", "-t", name, "Enter"]);
}

/**
 * Inject text into a tmux session (literal keys, no Enter).
 * Used for room event injection.
 */
export function tmuxInjectText(session: string, text: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "-l", text]);
}

/** Send Enter key to a tmux session (submits input). */
export function tmuxSendEnter(session: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "Enter"]);
}

/** Attach to a tmux session. Returns a promise that resolves when detached/exited.
 *
 * Two modes:
 *  - Outside tmux: `tmux attach` (blocks until user detaches, event loop stays free via spawn)
 *  - Inside tmux:  `tmux switch-client` (exits immediately) + polls until session ends
 */
export function tmuxAttach(session: string): Promise<void> {
  const name = sanitizeSessionName(session);

  if (process.env.TMUX) {
    // switch-client exits immediately after switching — poll until session is destroyed
    try {
      execFileSync("tmux", ["switch-client", "-t", name], { stdio: "ignore" });
    } catch {
      // switch-client failed (e.g. no client) — fall through to polling
    }
    return new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        try {
          execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
        } catch {
          clearInterval(poll);
          resolve();
        }
      }, 500);
    });
  }

  return new Promise<void>((resolve) => {
    const child = spawn("tmux", ["attach", "-t", name], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/** Capture visible screen content as array of lines. */
export function tmuxCapturePane(session: string): string[] {
  try {
    const name = sanitizeSessionName(session);
    const output = execFileSync("tmux", ["capture-pane", "-t", name, "-p"], {
      encoding: "utf-8",
    });
    return trimTrailingBlankLines(output.split("\n"));
  } catch {
    return [];
  }
}

/**
 * Drop trailing blank lines from a capture.
 *
 * `capture-pane` returns every row of the pane, blank ones included. Both
 * bridges then read "the bottom of the screen" as `lines.slice(-N)` to decide
 * what the CLI is doing — which silently stops working the moment the pane is
 * taller than the CLI's rendered output: the slice lands entirely in the empty
 * rows, every state reads as "unknown", and the bridge queues events forever
 * instead of delivering them.
 *
 * Trimming here rather than in each detector keeps "the last N lines" meaning
 * "the last N lines of actual content" for every caller.
 */
export function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/**
 * Send a control key sequence (e.g. "C-u", "C-y", "Escape").
 * Unlike tmuxInjectText, this does NOT use -l, so tmux interprets
 * the key name rather than treating it as literal text.
 */
export function tmuxSendKey(session: string, key: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, key]);
}

/** Kill a tmux session. */
export function tmuxKillSession(session: string): void {
  try {
    const name = sanitizeSessionName(session);
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
}

/**
 * Reset terminal to a sane state.
 *
 * Killing tmux sessions can leave the terminal with broken line discipline
 * (no echo, raw mode, garbled input). This restores it. Call after any
 * tmux teardown that might affect the user's terminal.
 */
export function resetTerminal(): void {
  // No-op when stdin isn't a tty (headless, piped, backgrounded). Calling
  // stty in that case prints "stdin isn't a terminal" to stderr for no gain.
  if (!process.stdin.isTTY) return;
  try {
    // stty sane restores line discipline (echo, cooked mode, signals)
    execFileSync("stty", ["sane"], { stdio: "inherit" });
  } catch {
    // Best effort
  }
}

/**
 * Shells, by process name.
 *
 * Detecting the SHELL rather than the agent is deliberate. A pane running an
 * agent reports whatever that CLI happens to call its process — Claude Code
 * reports its own version string, e.g. "2.1.267" — so there is nothing stable
 * to match on. Shells, by contrast, are a small and stable set.
 *
 * Screen text is no help either: a prompt is infinitely customisable (this
 * machine's is a starship prompt with a python env and a clock), so
 * "does it look like a shell?" cannot be answered from the rendering.
 */
const SHELL_COMMANDS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh",
  "nu", "pwsh", "powershell", "login", "elvish", "xonsh",
]);

/** The command tmux reports as running in the pane, or null if unknown. */
export function tmuxPaneCommand(session: string): string | null {
  try {
    const name = sanitizeSessionName(session);
    const out = execFileSync("tmux", ["display-message", "-p", "-t", name, "#{pane_current_command}"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * True if the pane is sitting at a shell, meaning the agent CLI has exited.
 *
 * The case that prompted this: Codex self-updated on launch, printed
 * "Update ran successfully! Please restart Codex" and exited. The pane fell
 * back to zsh, the bridge read the shell prompt as an idle agent, and typed a
 * room message into the shell — "zsh: command not found: Please".
 *
 * Returns false when tmux cannot say, so an unknown answer never escalates
 * into "the agent is gone".
 */
export function tmuxPaneIsShell(session: string): boolean {
  const cmd = tmuxPaneCommand(session);
  if (!cmd) return false;
  return SHELL_COMMANDS.has(cmd.toLowerCase().replace(/^-/, ""));
}
