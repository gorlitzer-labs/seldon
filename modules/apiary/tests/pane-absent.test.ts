/**
 * Tests for refusing to inject when the agent CLI is gone.
 *
 * The case that prompted this, verbatim from a real pane: Codex self-updated
 * on launch, printed "Update ran successfully! Please restart Codex" and
 * exited. The pane fell back to zsh, the bridge read the shell prompt as an
 * idle composer, and typed a room message at the shell:
 *
 *     zsh: command not found: Please
 *
 * Two design choices worth pinning, because both are counter-intuitive:
 *
 *   1. It detects the SHELL, not the agent. A pane running an agent reports
 *      whatever that CLI calls its process — Claude Code reports its own
 *      version string, "2.1.267" — so there is nothing stable to match on.
 *      Shells are a small, stable set.
 *   2. It uses tmux's pane_current_command, not the screen. A prompt is
 *      infinitely customisable, so "does this look like a shell?" cannot be
 *      answered from the rendering at all.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";

import { tmuxPaneCommand, tmuxPaneIsShell } from "../src/cli/tmux.js";
import { detectCodexStateFromLines, CodexTmuxBridge } from "../src/cli/codex/tmux-bridge.js";
import { detectStateFromLines, TmuxBridge } from "../src/cli/claude/tmux-bridge.js";
import { codexStateToActivity, claudeStateToActivity } from "../src/cli/agent-state.js";
import { trimTrailingBlankLines } from "../src/cli/tmux.js";

function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return trimTrailingBlankLines(lines);
}

/** Verbatim from the pane where this happened. */
const DEAD_CODEX_PANE = screen(`
🎉 Update ran successfully! Please restart Codex.
> Please join the apiary room you were invited to by calling the join_room tool with this URL: http://100.112.183.19:7890/?token=abc
zsh: command not found: Please
~/Desktop/apiary-game lanes/integration >                              py base 09:55:33
`);

describe("the screen alone cannot tell you the agent is gone", () => {
  test("a dead Codex pane still parses as idle from its text", () => {
    // This is why the fix is not another pattern: there is genuinely nothing
    // in the rendering that distinguishes this from a working composer.
    expect(detectCodexStateFromLines(DEAD_CODEX_PANE)).toBe("idle");
  });

  test("which is exactly how a room message got typed at the shell", () => {
    // "idle" is the one state the bridge injects into.
    expect(codexStateToActivity(detectCodexStateFromLines(DEAD_CODEX_PANE))).toBe("idle");
  });
});

describe("tmuxPaneIsShell against a REAL shell pane", () => {
  // The two mutants that survived without this: removing the absent check
  // entirely, and emptying the shell-name set. Both passed because every
  // other test here only asserts that agents are NOT shells — nothing
  // exercised the positive case, which needs an actual tmux session.
  const SESSION = `apiary_test_shell_${process.pid}`;
  let available = false;

  beforeAll(() => {
    try {
      execFileSync("tmux", ["new-session", "-d", "-s", SESSION], { stdio: "ignore", timeout: 10_000 });
      available = true;
    } catch {
      available = false; // no tmux in this environment
    }
  });

  afterAll(() => {
    if (available) {
      try { execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" }); } catch { /* ok */ }
    }
  });

  test("a bare shell pane IS detected as a shell", () => {
    if (!available) return;
    expect(tmuxPaneCommand(SESSION)).toBeTruthy();
    expect(tmuxPaneIsShell(SESSION)).toBe(true);
  });

  test("and the Codex bridge reports it absent rather than idle", () => {
    if (!available) return;
    // The whole point: this pane's TEXT is a shell prompt, which the screen
    // parser reads as an idle composer. The pane command is what saves it.
    const bridge = new CodexTmuxBridge(SESSION);
    expect(bridge.detectState()).toBe("absent");
    bridge.stop();
  });

  test("and the Claude bridge does too", () => {
    if (!available) return;
    const bridge = new TmuxBridge(SESSION);
    expect(bridge.detectState()).toBe("absent");
    bridge.stop();
  });

  test("so the room says needs-you, not idle", () => {
    if (!available) return;
    const bridge = new CodexTmuxBridge(SESSION);
    expect(codexStateToActivity(bridge.detectState())).toBe("blocked");
    bridge.stop();
  });
});

describe("tmuxPaneIsShell", () => {
  test("a real agent pane is not a shell", () => {
    // Both live agents at the time of writing: Codex reports "codex",
    // Claude Code reports "2.1.267". Neither is in the shell set.
    for (const s of ["apiary_fableboy", "apiary_aztraboy"]) {
      const cmd = tmuxPaneCommand(s);
      if (cmd === null) continue; // session not running in this environment
      expect(tmuxPaneIsShell(s), `${s} reported ${cmd}`).toBe(false);
    }
  });

  test("a session that does not exist is NOT reported as a shell", () => {
    // Fail-safe: an unknown answer must not escalate into "the agent is gone",
    // which would make the room claim a healthy agent needs attention.
    expect(tmuxPaneIsShell("definitely_not_a_session_" + Date.now())).toBe(false);
    expect(tmuxPaneCommand("definitely_not_a_session_" + Date.now())).toBeNull();
  });
});

describe("the room reports a dead agent as needing you, not idle", () => {
  test("codex: absent maps to blocked", () => {
    // A human has to restart it — which is what "needs you" means. Reporting
    // idle is how a dead agent sat in the room looking available.
    expect(codexStateToActivity("absent")).toBe("blocked");
  });

  test("claude: absent maps to blocked", () => {
    expect(claudeStateToActivity("absent")).toBe("blocked");
  });

  test("absent is never reported as idle or working", () => {
    for (const map of [codexStateToActivity, claudeStateToActivity]) {
      const got = map("absent" as never);
      expect(got).not.toBe("idle");
      expect(got).not.toBe("working");
    }
  });
});

describe("a live Claude pane is unaffected", () => {
  test("the busy-with-subagent pane still reads as working", () => {
    // Regression guard: the absent check runs before screen parsing, so it
    // must not disturb states that were already correct.
    const lines = screen(`
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
`);
    expect(claudeStateToActivity(detectStateFromLines(lines))).toBe("working");
  });
});
