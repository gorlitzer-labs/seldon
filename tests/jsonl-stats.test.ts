/** Tests for src/cli/claude/jsonl-stats.ts — the token/context parser. */

import { describe, test, expect, beforeEach } from "vitest";
import { consumeLine, cwdToProjectDir, _resetForTest } from "../src/cli/claude/jsonl-stats.js";

beforeEach(() => { _resetForTest(); });

describe("cwdToProjectDir", () => {
  test("encodes absolute path by replacing slashes with dashes", () => {
    expect(cwdToProjectDir("/Users/foo/bar")).toBe("-Users-foo-bar");
  });
  test("preserves leading slash as leading dash", () => {
    expect(cwdToProjectDir("/")).toBe("-");
  });
});

describe("consumeLine", () => {
  function freshState() {
    return {
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      lastTurnContextTokens: 0,
      lastModel: "",
    };
  }

  test("ignores blank lines", () => {
    const s = freshState();
    consumeLine(s, "");
    consumeLine(s, "   ");
    expect(s.totals.inputTokens).toBe(0);
  });

  test("ignores malformed JSON", () => {
    const s = freshState();
    consumeLine(s, "not json at all");
    consumeLine(s, "{partial");
    expect(s.totals.inputTokens).toBe(0);
    expect(s.lastModel).toBe("");
  });

  test("ignores events without usage", () => {
    const s = freshState();
    consumeLine(s, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
    expect(s.totals.inputTokens).toBe(0);
  });

  test("aggregates token totals across multiple assistant messages", () => {
    const s = freshState();
    consumeLine(s, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      },
    }));
    consumeLine(s, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
      },
    }));
    expect(s.totals.inputTokens).toBe(120);
    expect(s.totals.outputTokens).toBe(80);
    expect(s.totals.cacheReadTokens).toBe(2500);
    expect(s.totals.cacheCreateTokens).toBe(200);
  });

  test("lastTurnContextTokens reflects the latest turn only, not the sum", () => {
    const s = freshState();
    consumeLine(s, JSON.stringify({
      message: { model: "claude-opus-4-7", usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
    }));
    consumeLine(s, JSON.stringify({
      message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 200 } },
    }));
    expect(s.lastTurnContextTokens).toBe(5 + 50_000 + 200);
  });

  test("inherits last model when a message omits the model field", () => {
    const s = freshState();
    consumeLine(s, JSON.stringify({
      message: { model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }));
    consumeLine(s, JSON.stringify({
      message: { usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }));
    expect(s.lastModel).toBe("claude-opus-4-7");
    // Token totals accumulate across both turns
    expect(s.totals.inputTokens).toBe(15);
  });
});
