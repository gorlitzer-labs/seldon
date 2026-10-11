/**
 * Tests for opening an agent's terminal in a new window.
 *
 * Two behaviours here were established by testing against a real terminal and
 * a real tmux, and both are easy to regress silently:
 *
 *   1. The command must carry an ABSOLUTE tmux path. Terminals launch it
 *      without a login shell, so a bare `tmux` is not on PATH and the window
 *      opens and dies instantly — looking like "nothing happened".
 *   2. The attach must be read-only by default, because a keystroke in an
 *      agent's pane types into its composer and submits.
 */

import { describe, test, expect } from "vitest";

import {
  pickTerminal,
  launcherFor,
  terminalFromEnv,
  watchCommand,
  resolveTmuxPath,
  type TerminalLauncher,
  type TerminalKind,
} from "../src/cli/watch.js";

/** A launcher table with controlled availability, so these tests say the same
 *  thing on a laptop with iTerm and on a Linux CI runner with no GUI at all. */
function fakeLaunchers(...available: TerminalKind[]): TerminalLauncher[] {
  const all: TerminalKind[] = ["iterm", "ghostty", "wezterm", "kitty", "alacritty", "apple-terminal"];
  return all.map((kind) => ({
    kind,
    available: () => available.includes(kind),
    argv: (command: string) => [kind, command],
  }));
}

const TMUX = "/opt/homebrew/bin/tmux";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("watchCommand", () => {
  test("read-only by default", () => {
    // A stray keypress otherwise goes into the agent's composer and submits.
    expect(watchCommand(TMUX, "apiary_bee")).toBe(`${TMUX} attach -r -t apiary_bee`);
  });

  test("--control gives a writable client", () => {
    expect(watchCommand(TMUX, "apiary_bee", { control: true }))
      .toBe(`${TMUX} attach -t apiary_bee`);
  });

  test("always uses the absolute tmux path", () => {
    // Terminals get no login shell: a bare `tmux` would not be found and the
    // window would close before the user saw anything.
    const cmd = watchCommand(TMUX, "apiary_bee");
    expect(cmd.startsWith("/")).toBe(true);
    expect(cmd).not.toMatch(/(^|\s)tmux\s/);
  });

  test("targets the session it was given", () => {
    expect(watchCommand(TMUX, "apiary_aztraboy")).toContain("-t apiary_aztraboy");
  });
});

describe("resolveTmuxPath", () => {
  test("returns an absolute path, or null when tmux is absent", () => {
    // Absolute is the whole point: terminals launch the command without a
    // login shell, so a relative or bare name would not resolve.
    const found = resolveTmuxPath();
    if (found !== null) expect(found.startsWith("/")).toBe(true);
  });
});

describe("terminalFromEnv", () => {
  test("recognises the terminal apiary is running in", () => {
    expect(terminalFromEnv(env({ TERM_PROGRAM: "iTerm.app" }))).toBe("iterm");
    expect(terminalFromEnv(env({ TERM_PROGRAM: "Apple_Terminal" }))).toBe("apple-terminal");
    expect(terminalFromEnv(env({ TERM_PROGRAM: "ghostty" }))).toBe("ghostty");
    expect(terminalFromEnv(env({ TERM_PROGRAM: "WezTerm" }))).toBe("wezterm");
    expect(terminalFromEnv(env({ KITTY_WINDOW_ID: "1" }))).toBe("kitty");
    expect(terminalFromEnv(env({ ALACRITTY_WINDOW_ID: "1" }))).toBe("alacritty");
  });

  test("unknown terminal is null, not a wrong guess", () => {
    expect(terminalFromEnv(env({ TERM_PROGRAM: "Hyper" }))).toBeNull();
    expect(terminalFromEnv(env({}))).toBeNull();
  });
});

describe("pickTerminal", () => {
  test("prefers the terminal the user is already in", () => {
    // So the watcher window inherits their theme, font and profile.
    const picked = pickTerminal(env({ TERM_PROGRAM: "iTerm.app" }), fakeLaunchers("iterm", "kitty"));
    expect(picked?.kind).toBe("iterm");
  });

  test("falls back in table order when the current terminal is unrecognised", () => {
    const picked = pickTerminal(env({ TERM_PROGRAM: "Hyper" }), fakeLaunchers("kitty", "alacritty"));
    expect(picked?.kind).toBe("kitty");
  });

  test("falls back when the current terminal is known but not installed", () => {
    // e.g. TERM_PROGRAM says ghostty but only kitty is on this box.
    const picked = pickTerminal(env({ TERM_PROGRAM: "ghostty" }), fakeLaunchers("kitty"));
    expect(picked?.kind).toBe("kitty");
  });

  test("null when no terminal is available at all", () => {
    // A headless server, or CI. openAgentWatcher reports this rather than
    // spawning something that cannot work.
    expect(pickTerminal(env({}), fakeLaunchers())).toBeNull();
  });
});

describe("launch argv", () => {
  test("iTerm gets the command as an AppleScript string, properly escaped", () => {
    const argv = launcherFor("iterm").argv(`${TMUX} attach -r -t apiary_bee`);

    expect(argv[0]).toBe("osascript");
    expect(argv.join(" ")).toContain("create window with default profile");
    expect(argv.join(" ")).toContain(`${TMUX} attach -r -t apiary_bee`);
  });

  test("a quote in the command cannot break out of the AppleScript literal", () => {
    const script = launcherFor("iterm").argv('tmux attach -t "evil" \\ end tell').join(" ");

    // The injected quote must arrive escaped, not as a literal delimiter.
    expect(script).toContain('\\"evil\\"');
  });

  test("every known terminal produces a non-empty argv", () => {
    for (const kind of ["iterm", "ghostty", "wezterm", "kitty", "alacritty", "apple-terminal"] as const) {
      const argv = launcherFor(kind).argv(`${TMUX} attach -r -t apiary_bee`);
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.join(" ")).toContain("apiary_bee");
    }
  });
});
