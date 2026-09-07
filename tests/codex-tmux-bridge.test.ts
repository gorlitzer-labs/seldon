/** Tests for CodexTmuxBridge state detection heuristics. */

import { describe, test, expect } from "vitest";
import { detectCodexStateFromLines, type CodexTuiState } from "../src/cli/codex/tmux-bridge.js";

/** Helper: split a template string into lines (trims leading blank line). */
function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

describe("detectCodexStateFromLines", () => {
  // ── Approval ────────────────────────────────────────────────────────────

  test("detects approval: exec command approval", () => {
    const lines = screen(`
  Would you like to run the following command?

    npm test

  y  Yes, proceed
  a  Yes, and don't ask again for this command in this session
  d  No, continue without running it
  n  No, and tell Codex what to do differently

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: patch approval", () => {
    const lines = screen(`
  Would you like to make the following edits?

  src/index.ts
  + import { foo } from "./foo.js";

  y  Yes, proceed
  a  Yes, and don't ask again for these files
  n  No, and tell Codex what to do differently

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: MCP elicitation", () => {
    const lines = screen(`
  apiary needs your approval.

  The MCP server is requesting access to perform an action.

  y  Yes, provide the requested info
  n  No, but continue without it

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: network access", () => {
    const lines = screen(`
  Do you want to approve network access to "api.example.com"?

  y  Yes, just this once
  p  Yes, and allow this host in the future
  d  No, and block this host in the future

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: confirm/cancel footer alone is enough", () => {
    const lines = screen(`
  Some approval prompt
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  // ── Streaming ──────────────────────────────────────────────────────────

  test("detects streaming: Working with elapsed time", () => {
    const lines = screen(`
  Previous conversation output here...

  Working (12s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: Working with minutes", () => {
    const lines = screen(`
  Working (1m 30s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: Working just started (no elapsed)", () => {
    const lines = screen(`
  Some output
  Working
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: spinner character", () => {
    const lines = screen(`
  ⠹ Thinking about the problem...
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: different spinner character", () => {
    const lines = screen(`
  Some context
  ⠼ Processing files...
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: esc to interrupt hint", () => {
    const lines = screen(`
  Reading files and analyzing code...
  (5s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  // ── Idle ───────────────────────────────────────────────────────────────

  test("detects idle: normal screen with conversation", () => {
    const lines = screen(`
  Agent: I've fixed the bug in src/utils.ts.

  The changes look correct. Let me know if you need anything else.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  test("detects idle: screen with just prompt area", () => {
    const lines = screen(`
  Welcome to Codex! Type a message to get started.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  test("detects idle: screen after agent completes a task", () => {
    const lines = screen(`
  ✓ Created file src/cli/codex/run.ts
  ✓ Updated src/cli/index.ts

  Done. 2 files modified.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  // ── Unknown ────────────────────────────────────────────────────────────

  test("returns unknown for empty screen", () => {
    expect(detectCodexStateFromLines([])).toBe("unknown");
  });

  test("returns unknown for blank lines only", () => {
    const lines = screen(`



`);
    // All lines are empty/whitespace
    expect(detectCodexStateFromLines(lines.filter(l => l.trim() === "" ? true : false) as any)).toBe("unknown");
  });

  // ── Priority ───────────────────────────────────────────────────────────

  test("approval takes priority over idle", () => {
    const lines = screen(`
  Agent completed some work.
  Output from previous task.

  Would you like to run the following command?
    rm -rf node_modules
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("streaming takes priority over idle", () => {
    const lines = screen(`
  Previous output
  Some conversation text
  Working (3s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("approval takes priority over streaming indicators", () => {
    // Edge case: approval text present alongside streaming-like content
    const lines = screen(`
  Working on the task...
  Would you like to run the following command?
    npm install
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  // ── Blocked: no composer exists yet ─────────────────────────────────────

  test("detects blocked: OAuth sign-in screen", () => {
    // Verbatim from a Codex v0.153.4 launch with an empty CODEX_HOME — the
    // screen that swallowed a room invite and left the agent "not found".
    const lines = screen(`
  Welcome to Codex, OpenAI's command-line coding agent

  Finish signing in via your browser

  If the link doesn't open automatically, open the following link to
authenticate:

  https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x

  On a remote or headless machine? Press esc and choose Sign in with Device
  Code.

  Press esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("blocked");
  });

  test("detects blocked: sign-in method menu", () => {
    const lines = screen(`
  > 1. Sign in with ChatGPT
       Usage included with Plus, Pro, Business, and Enterprise plans

    2. Sign in with Device Code
       Sign in from another device with a one-time code

    3. Provide your own API key
       Pay for what you use

  Press enter to continue
`);
    expect(detectCodexStateFromLines(lines)).toBe("blocked");
  });

  test("detects blocked: directory trust prompt", () => {
    const lines = screen(`
  You are running Codex in ~/Desktop/apiary-game

  Do you trust the files in this folder?

  > 1. Yes, allow Codex to work in this folder
    2. No, choose a different folder
`);
    expect(detectCodexStateFromLines(lines)).toBe("blocked");
  });

  test("blocked takes priority over idle", () => {
    // Without this, "no approval + no spinner ⇒ idle" pastes into a login menu.
    const lines = screen(`
  Some earlier conversation output

  Welcome to Codex, OpenAI's command-line coding agent
  Finish signing in via your browser
`);
    expect(detectCodexStateFromLines(lines)).not.toBe("idle");
    expect(detectCodexStateFromLines(lines)).toBe("blocked");
  });

  // ── Approval: current Codex UI ──────────────────────────────────────────

  test("detects approval: MCP tool approval (v0.15x wording)", () => {
    // Verbatim from Codex v0.153.4 on apiary__join_room. None of the original
    // APPROVAL_PATTERNS match this screen, so it was classified idle.
    const lines = screen(`
  Field 1/1
  Allow the apiary MCP server to run tool "apiary__join_room"?

  url: http://127.0.0.1:7890/?token=5c1dc48b

  > 1. Allow                   Run the tool and continue.
    2. Allow for this session  Run the tool and remember this choice for this
                                session.
    3. Always allow            Run the tool and remember this choice for
                                future tool calls.
    4. Cancel                  Cancel this tool call
  enter to submit | esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("normal conversation containing the word allow is still idle", () => {
    const lines = screen(`
  I'll allow the build to finish before running the tests.
  Done — 320 tests passed.

  > Ask Codex to do anything
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });
});
