import { test } from "node:test";
import assert from "node:assert/strict";
import { readCommand, lastAssistantText, sayCommands } from "../lib/lanes.mjs";

const tmuxLane = { harness: "codex", tmuxSession: "seldon_fix", state: "needs-you" };
const bgClaude = { harness: "claude", id: "c09d", sessionId: "abc-1", state: "needs-you" };

test("readCommand: Claude reads its conversation file, anything else its tmux screen", () => {
  assert.deepEqual(readCommand(bgClaude), { transcript: "abc-1.jsonl" });
  assert.deepEqual(readCommand(tmuxLane).args.slice(0, 5), ["capture-pane", "-p", "-J", "-t", "seldon_fix"]);
  assert.ok(readCommand({ harness: "opencode" }).why);
});

test("lastAssistantText: the last assistant text block, skipping tool calls and junk lines", () => {
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
    "not json",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Which domain for staging?" }, { type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    JSON.stringify({ type: "user", message: { content: "ok" } }),
  ].join("\n");
  assert.equal(lastAssistantText(jsonl), "Which domain for staging?");
  assert.equal(lastAssistantText(""), "");
});

test("sayCommands: types the line and Enter into a waiting tmux agent, one line only", () => {
  assert.deepEqual(sayCommands(tmuxLane, "use staging\nplease").cmds, [
    ["tmux", "send-keys", "-t", "seldon_fix", "-l", "use staging please"],
    ["tmux", "send-keys", "-t", "seldon_fix", "Enter"],
  ]);
});

test("sayCommands: never types into a working agent, a background session, or with nothing to say", () => {
  assert.match(sayCommands({ ...tmuxLane, state: "working" }, "yes").why, /working/);
  assert.match(sayCommands(bgClaude, "yes").why, /open it/);
  assert.match(sayCommands(tmuxLane, "  ").why, /nothing/);
});
