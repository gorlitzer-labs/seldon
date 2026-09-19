/**
 * A catalogue of every way an agent can stop making progress, and what apiary
 * does about each.
 *
 * The premise: an agent apiary spawned into a room has nobody watching its
 * pane. Anything that waits for a keypress there waits forever, and from the
 * room's side it is indistinguishable from thinking. So each stall needs
 * either prevention (no prompt in the first place) or detection (the room says
 * "needs you"). This file pins both, so a regression shows up as a failing
 * test rather than an agent quietly parked for an hour.
 */

import { describe, test, expect } from "vitest";

import { wantsUnattendedAgents } from "../src/cli/approvals.js";
import { renderCodexProfile, codexToolApprovalMode } from "../src/cli/codex/launch.js";
import { detectCodexStateFromLines } from "../src/cli/codex/tmux-bridge.js";
import { detectStateFromLines } from "../src/cli/claude/tmux-bridge.js";
import { codexStateToActivity, claudeStateToActivity } from "../src/cli/agent-state.js";
import { trimTrailingBlankLines } from "../src/cli/tmux.js";
import { DEFAULT_RULES } from "../src/core/rules.js";
import { readFileSync } from "node:fs";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const MCP = "http://127.0.0.1:1/mcp";

/** What the room would show for this Codex screen. */
function codexRoomState(lines: string[]) {
  return codexStateToActivity(detectCodexStateFromLines(trimTrailingBlankLines(lines)));
}

describe("PREVENTED: prompts never appear", () => {
  test("codex shell/command approvals are off by default", () => {
    // Observed in one real session: a smoke test, a dev server and a `git add`
    // each halted the agent until a human noticed.
    expect(renderCodexProfile(MCP)).toContain('approval_policy = "never"');
  });

  test("codex MCP tool approvals are off by default", () => {
    // A separate gate — approval_policy does NOT cover MCP tool calls.
    expect(codexToolApprovalMode(env({}))).toBe("approve");
    expect(renderCodexProfile(MCP)).toContain("[mcp_servers.apiary.tools.apiary__join_room]");
  });

  test("unattended is the default, and opt-out-able", () => {
    expect(wantsUnattendedAgents(env({}))).toBe(true);
    expect(wantsUnattendedAgents(env({ APIARY_AGENT_APPROVALS: "ask" }))).toBe(false);
    expect(wantsUnattendedAgents(env({ APIARY_AGENT_APPROVALS: "ASK" }))).toBe(false);
    // Anything else means "leave it unattended" rather than silently prompting.
    expect(wantsUnattendedAgents(env({ APIARY_AGENT_APPROVALS: "auto" }))).toBe(true);
    expect(wantsUnattendedAgents(env({ APIARY_AGENT_APPROVALS: "" }))).toBe(true);
  });
});

describe("DETECTED: the room reports 'needs you'", () => {
  test("codex: a command approval that somehow still appears", () => {
    // Prevention is config, and config can be overridden or out of date. If a
    // prompt does appear, it must not read as "working".
    expect(codexRoomState([
      "  Would you like to run the following command?",
      "  $ rm -rf build",
      "  Press enter to confirm or esc to cancel",
    ])).toBe("blocked");
  });

  test("codex: an MCP tool approval", () => {
    expect(codexRoomState([
      '  Allow the apiary MCP server to run tool "apiary__join_room"?',
      "  enter to submit | esc to cancel",
    ])).toBe("blocked");
  });

  test("codex: a sign-in screen", () => {
    expect(codexRoomState([
      "  Welcome to Codex, OpenAI's command-line coding agent",
      "  Finish signing in via your browser",
    ])).toBe("blocked");
  });

  test("codex: a device-code sign-in", () => {
    expect(codexRoomState(["  2. Sign in with Device Code"])).toBe("blocked");
  });

  test("codex: an exec approval, using the binary's own wording", () => {
    expect(codexRoomState(["  Allow Codex to run `npm test`?"])).toBe("blocked");
  });

  test("codex: a patch approval", () => {
    expect(codexRoomState(["  Allow Codex to apply proposed code changes?"])).toBe("blocked");
  });

  test("codex: a trust prompt split across lines", () => {
    // The pattern used `.` which does not cross a newline, so a two-line
    // rendering never matched and read as idle.
    expect(codexRoomState([
      "  You are running Codex in ~/Desktop/other-repo",
      "",
      "  Do you want to allow Codex to work here?",
    ])).toBe("blocked");
  });

  test("claude: a tool-permission prompt", () => {
    // Current Claude Code wording. The shipped patterns matched none of it.
    const state = detectStateFromLines([
      "  Bash command",
      "  npm test",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. Yes, and don't ask again",
    ]);
    expect(claudeStateToActivity(state)).toBe("blocked");
  });

  test("claude: each permission marker is pinned on its own", () => {
    // Pinned individually, or dropping one pattern still passes on a fixture
    // that happens to contain another.
    for (const marker of ["Do you want to proceed?", "don't ask again", "Yes, I trust this folder"]) {
      const state = detectStateFromLines(["  some agent output", `  ${marker}`]);
      expect(claudeStateToActivity(state), `marker: ${marker}`).toBe("blocked");
    }
  });

  test("codex: each approval marker is pinned on its own", () => {
    for (const marker of [
      "Press enter to confirm or esc to cancel",
      "Allow Codex to run `x`?",
      "Allow Codex to apply proposed code changes?",
      "Would you like to run the following command?",
    ]) {
      expect(codexRoomState(["  output", `  ${marker}`]), `marker: ${marker}`).toBe("blocked");
    }
  });

  test("claude: the folder-trust modal, which NO flag skips", () => {
    // Verbatim from a live session. Verified that neither
    // --dangerously-skip-permissions nor --permission-mode bypassPermissions
    // gets past it.
    const state = detectStateFromLines([
      " Quick safety check: Is this a project you created or one you trust?",
      " Claude Code'll be able to read, edit, and execute files here.",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ]);
    expect(claudeStateToActivity(state)).toBe("blocked");
  });

  test("a working agent is NOT reported as blocked", () => {
    // The inverse error is just as bad: crying "needs you" on a busy agent
    // trains the user to ignore the signal.
    expect(codexRoomState(["• Working (8s • esc to interrupt)"])).toBe("working");
  });

  test("an idle agent is NOT reported as blocked", () => {
    expect(codexRoomState(["• Done.", "", "› Ask Codex to do anything"])).toBe("idle");
  });
});

describe("DETECTED: a tall pane does not hide the state", () => {
  test("a prompt at the top of a 50-row pane is still seen", () => {
    // Agent panes are 200x50; the CLIs render at the top, so an untrimmed
    // capture's last 20 lines are all blank and every state reads "unknown"
    // — which makes the bridge queue events forever.
    const tall = [
      "  Would you like to run the following command?",
      "  Press enter to confirm or esc to cancel",
      ...Array(48).fill(""),
    ];
    expect(codexRoomState(tall)).toBe("blocked");
    expect(codexStateToActivity(detectCodexStateFromLines(tall))).not.toBe("blocked");
  });
});

describe("NOT a CLI stall: the agent has a question", () => {
  // No flag fixes this one. The agent finishes its turn with a question in its
  // own terminal and goes idle; the room shows idle, which looks like "done".
  // The only fix is telling it where questions go.

  test("the room rules name the mechanism, not just the intent", () => {
    const askRule = DEFAULT_RULES.find((r) => r.includes("uncertain"));
    expect(askRule).toBeDefined();
    // "When uncertain, ask" is satisfiable by talking to an unread terminal.
    expect(askRule).toMatch(/send_message/);
    expect(askRule).toMatch(/room/);
  });

  test("the rules stay within the documented cap", () => {
    // Past ~12, per-rule compliance drops sharply — adding guidance has a cost.
    expect(DEFAULT_RULES.length).toBeLessThanOrEqual(12);
  });
});

describe("PREVENTED: Claude's folder-trust modal", () => {
  test("pre-acceptance is part of the unattended default", () => {
    // No flag skips this modal, so an agent in an unseen repo would stall on
    // it regardless of --dangerously-skip-permissions.
    expect(wantsUnattendedAgents(env({}))).toBe(true);
  });
});

describe("COVERED ELSEWHERE", () => {
  test("the room daemon restarting does not orphan an agent", () => {
    // sse-multiplexer reconnects with exponential backoff, so an agent
    // outlives a `room resume` rather than going deaf.
    const src = readFileSync(new URL("../src/agent/sse-multiplexer.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/backoff/);
  });

  test("a lost invite is retried rather than dropped", () => {
    // deliverInvite keeps asking until the agent is really in the room.
    const src = readFileSync(new URL("../src/cli/invites.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/deliverInvite/);
    expect(src).toMatch(/abandoned/);
  });
});
