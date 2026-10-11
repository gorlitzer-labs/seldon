/**
 * Tests for pre-accepting Claude Code's folder-trust dialog.
 *
 * The dialog is not skippable by flag — verified against Claude Code with both
 * --dangerously-skip-permissions and --permission-mode bypassPermissions, both
 * of which land on it. So an agent spawned into an unseen repo waits on a modal
 * nobody is watching, and the only way past is the acceptance Claude records
 * itself.
 *
 * The file being edited is the user's real ~/.claude.json, holding dozens of
 * projects plus allowedTools and MCP config. Losing it is far worse than one
 * trust prompt, so most of what follows is about not damaging it.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { preAcceptClaudeTrust, claudeConfigPath } from "../src/cli/claude/trust.js";

let dir: string;
let cfg: string;
const CWD = "/Users/someone/Desktop/a-repo";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apiary_trust_test_"));
  cfg = join(dir, ".claude.json");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
});

const read = () => JSON.parse(readFileSync(cfg, "utf-8"));

describe("preAcceptClaudeTrust", () => {
  test("records acceptance for the agent's cwd", () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }));

    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("trusted");
    expect(read().projects[CWD].hasTrustDialogAccepted).toBe(true);
  });

  test("is a no-op when Claude already trusts it", () => {
    writeFileSync(cfg, JSON.stringify({
      projects: { [CWD]: { hasTrustDialogAccepted: true } },
    }));

    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("already-trusted");
  });

  test("keeps everything else in the project entry", () => {
    // These hold real state — dropping allowedTools would silently re-prompt
    // for every tool the user had already approved.
    writeFileSync(cfg, JSON.stringify({
      projects: {
        [CWD]: {
          allowedTools: ["Bash(npm test)"],
          mcpServers: { foo: { command: "bar" } },
          lastCost: 1.23,
        },
      },
    }));

    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("trusted");
    const entry = read().projects[CWD];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.allowedTools).toEqual(["Bash(npm test)"]);
    expect(entry.mcpServers).toEqual({ foo: { command: "bar" } });
    expect(entry.lastCost).toBe(1.23);
  });

  test("never touches other projects or top-level settings", () => {
    writeFileSync(cfg, JSON.stringify({
      numStartups: 412,
      userID: "abc",
      projects: {
        "/other/repo": { hasTrustDialogAccepted: true, allowedTools: ["Read"] },
      },
    }));

    preAcceptClaudeTrust(CWD, { configPath: cfg });
    const after = read();
    expect(after.numStartups).toBe(412);
    expect(after.userID).toBe("abc");
    expect(after.projects["/other/repo"]).toEqual({
      hasTrustDialogAccepted: true, allowedTools: ["Read"],
    });
  });

  test("keys by absolute path, as Claude does", () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }));
    preAcceptClaudeTrust("/Users/someone/../someone/Desktop/a-repo", { configPath: cfg });
    expect(Object.keys(read().projects)).toEqual([resolve(CWD)]);
  });

  test("a malformed config is left completely alone", () => {
    // Rewriting a file we failed to parse risks destroying the whole config.
    const junk = "{ this is not json";
    writeFileSync(cfg, junk);

    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("failed");
    expect(readFileSync(cfg, "utf-8")).toBe(junk);
  });

  test("a config whose projects field is not an object is left alone", () => {
    writeFileSync(cfg, JSON.stringify({ projects: "nope" }));
    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("failed");
    expect(read().projects).toBe("nope");
  });

  test("no config at all is reported, not created", () => {
    // Claude has never run on this machine; inventing its config could break
    // its own first-run flow.
    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("no-config");
    expect(existsSync(cfg)).toBe(false);
  });

  test("creates a projects map when the config has none", () => {
    writeFileSync(cfg, JSON.stringify({ numStartups: 1 }));
    expect(preAcceptClaudeTrust(CWD, { configPath: cfg })).toBe("trusted");
    expect(read().projects[CWD].hasTrustDialogAccepted).toBe(true);
    expect(read().numStartups).toBe(1);
  });

  test("opting out skips it entirely", () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }));
    expect(preAcceptClaudeTrust(CWD, { configPath: cfg, enabled: false })).toBe("skipped");
    expect(read().projects).toEqual({});
  });

  test("leaves no temp file behind", () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }));
    preAcceptClaudeTrust(CWD, { configPath: cfg });
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  test("the written config is still valid JSON Claude can read", () => {
    writeFileSync(cfg, JSON.stringify({ projects: { [CWD]: { lastCost: 1 } } }));
    preAcceptClaudeTrust(CWD, { configPath: cfg });
    expect(() => JSON.parse(readFileSync(cfg, "utf-8"))).not.toThrow();
  });
});

describe("claudeConfigPath", () => {
  test("is ~/.claude.json", () => {
    expect(claudeConfigPath("/home/x")).toBe("/home/x/.claude.json");
  });
});
