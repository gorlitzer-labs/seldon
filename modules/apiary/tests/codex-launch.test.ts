/** Tests for how apiary declares itself to a Codex session. */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearCodexProfile,
  codexProfileName,
  codexProfilePath,
  codexToolApprovalMode,
  prepareCodexLaunch,
  pruneCodexProfiles,
  renderCodexProfile,
  userCodexHome,
} from "../src/cli/codex/launch.js";
import { RUNTIME_TOOL_NAMES } from "../src/agent/mcp/runtime.js";

const MCP_URL = "http://127.0.0.1:51475/mcp";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "apiary_codexhome_test_"));
});

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("renderCodexProfile", () => {
  test("declares apiary's MCP server", () => {
    const out = renderCodexProfile(MCP_URL);

    expect(out).toContain("[mcp_servers.apiary]");
    expect(out).toContain(`url = "${MCP_URL}"`);
    expect(out).toContain("startup_timeout_sec = 15");
    expect(out).toContain("tool_timeout_sec = 60");
  });

  test("every apiary tool gets its own approval table", () => {
    // Codex accepts `approval_mode` on the server table and then ignores it —
    // verified against v0.153.4. Only the per-tool form is honoured, so a
    // missing entry means the agent blocks on a keypress nobody will press.
    const out = renderCodexProfile(MCP_URL);

    for (const tool of RUNTIME_TOOL_NAMES) {
      expect(out).toContain(`[mcp_servers.apiary.tools.${tool}]\napproval_mode = "approve"`);
    }
  });

  test("join_room in particular is auto-approved", () => {
    // The one that matters: an agent that cannot join is not in the room.
    expect(renderCodexProfile(MCP_URL))
      .toContain('[mcp_servers.apiary.tools.apiary__join_room]\napproval_mode = "approve"');
  });

  test("no prompts, but the sandbox is NOT disabled", () => {
    // Prompts are the thing that stalls an unwatched agent, so they go. The
    // sandbox is what keeps a no-prompt agent from doing damage outside its
    // workspace, so it stays: a command Codex will not allow returns a failure
    // to the model instead of asking.
    const out = renderCodexProfile(MCP_URL);

    expect(out).toContain('approval_policy = "never"');
    expect(out).not.toContain("sandbox_mode");
    expect(out).not.toContain("danger-full-access");
    expect(out).not.toContain("dangerously");
  });

  test("APIARY_AGENT_APPROVALS=ask restores prompting", () => {
    const out = renderCodexProfile(MCP_URL, "ask", false);
    expect(out).not.toContain("approval_policy");
    expect(out).toContain('approval_mode = "ask"');
  });

  test("apiary only ever declares its own MCP server", () => {
    for (const line of renderCodexProfile(MCP_URL).split("\n")) {
      if (line.startsWith("[mcp_servers.")) {
        expect(line.startsWith("[mcp_servers.apiary")).toBe(true);
      }
    }
  });

  test("top-level keys precede every table header", () => {
    // TOML: a key after a header belongs to that table. approval_policy landing
    // under [mcp_servers.apiary] would parse as a server field and be ignored.
    const out = renderCodexProfile(MCP_URL);
    expect(out.indexOf("approval_policy")).toBeLessThan(out.indexOf("["));
  });

  test("declares nothing that would override the user's model or trust", () => {
    // The profile layers over the base config; anything it sets, it wins.
    const out = renderCodexProfile(MCP_URL);
    expect(out).not.toMatch(/^model\s*=/m);
    expect(out).not.toMatch(/^model_reasoning_effort\s*=/m);
    expect(out).not.toContain("[projects.");
  });

  test("honours a custom approval mode", () => {
    expect(renderCodexProfile(MCP_URL, "ask")).toContain('approval_mode = "ask"');
  });

  test("a URL with quotes cannot break out of the TOML string", () => {
    const nasty = 'http://127.0.0.1:1/mcp"\nmodel = "evil';
    const out = renderCodexProfile(nasty);

    expect(out).not.toMatch(/^model = "evil/m);
    expect(out).toContain(JSON.stringify(nasty));
  });
});

describe("codexProfileName", () => {
  test("namespaces the agent under apiary-", () => {
    expect(codexProfileName("qabee")).toBe("apiary-qabee");
  });

  test("cannot escape the Codex home", () => {
    // The name becomes a filename, so traversal must not survive.
    expect(codexProfileName("../../etc/passwd")).not.toContain("/");
    expect(codexProfileName("../../etc/passwd")).not.toContain("..");
    expect(codexProfileName("a/b")).toBe("apiary-a-b");
  });

  test("survives an empty or fully-stripped name", () => {
    expect(codexProfileName("")).toBe("apiary-agent");
    expect(codexProfileName("///")).toBe("apiary-agent");
  });

  test("is bounded in length", () => {
    expect(codexProfileName("x".repeat(500)).length).toBeLessThanOrEqual(72);
  });
});

describe("prepareCodexLaunch", () => {
  test("writes the profile and returns a short launch command", () => {
    const { command, profilePath } = prepareCodexLaunch("qabee", MCP_URL, [], home);

    expect(command).toBe("codex --profile apiary-qabee");
    expect(profilePath).toBe(join(home, "apiary-qabee.config.toml"));
    expect(readFileSync(profilePath, "utf-8")).toContain("[mcp_servers.apiary]");
  });

  test("the command stays short enough to type into a pane", () => {
    // A ~1.2KB command line of per-tool `-c` flags was the previous approach;
    // tmux truncated it mid-quote and wedged the shell at a `quote>` prompt.
    const { command } = prepareCodexLaunch("qabee", MCP_URL, [], home);
    expect(command.length).toBeLessThan(120);
  });

  test("the user's passthrough flags come last so they win", () => {
    const { command } = prepareCodexLaunch("qabee", MCP_URL, ["--model", "gpt-5.6-terra"], home);
    expect(command).toBe("codex --profile apiary-qabee --model gpt-5.6-terra");
  });

  test("the profile is owner-only — it names a local MCP endpoint", () => {
    const { profilePath } = prepareCodexLaunch("qabee", MCP_URL, [], home);
    expect(statSync(profilePath).mode & 0o777).toBe(0o600);
  });

  test("creates the Codex home if the user has never run codex", () => {
    const fresh = join(home, "never-used");
    const { profilePath } = prepareCodexLaunch("qabee", MCP_URL, [], fresh);
    expect(existsSync(profilePath)).toBe(true);
  });

  test("relaunching the same agent replaces its profile, not appends", () => {
    prepareCodexLaunch("qabee", "http://127.0.0.1:1111/mcp", [], home);
    const { profilePath } = prepareCodexLaunch("qabee", "http://127.0.0.1:2222/mcp", [], home);
    const body = readFileSync(profilePath, "utf-8");

    expect(body).toContain("2222");
    expect(body).not.toContain("1111");
  });

  test("does not touch the user's own config or credentials", () => {
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6-terra"');
    writeFileSync(join(home, "auth.json"), '{"tokens":{"refresh_token":"keep-me"}}');

    prepareCodexLaunch("qabee", MCP_URL, [], home);

    expect(readFileSync(join(home, "config.toml"), "utf-8")).toBe('model = "gpt-5.6-terra"');
    expect(readFileSync(join(home, "auth.json"), "utf-8")).toContain("keep-me");
  });
});

describe("clearCodexProfile", () => {
  test("removes the profile and is safe to repeat", () => {
    const { profilePath } = prepareCodexLaunch("qabee", MCP_URL, [], home);

    clearCodexProfile("qabee", home);
    expect(existsSync(profilePath)).toBe(false);
    expect(() => clearCodexProfile("qabee", home)).not.toThrow();
  });

  test("clears the same path prepareCodexLaunch wrote", () => {
    const { profilePath } = prepareCodexLaunch("weird/name", MCP_URL, [], home);
    expect(profilePath).toBe(codexProfilePath("weird/name", home));

    clearCodexProfile("weird/name", home);
    expect(existsSync(profilePath)).toBe(false);
  });
});

describe("pruneCodexProfiles", () => {
  test("sweeps profiles left by a crashed runtime, keeps the live ones", () => {
    prepareCodexLaunch("alive", MCP_URL, [], home);
    prepareCodexLaunch("crashed", MCP_URL, [], home);

    expect(pruneCodexProfiles(["alive"], home)).toBe(1);
    expect(existsSync(codexProfilePath("alive", home))).toBe(true);
    expect(existsSync(codexProfilePath("crashed", home))).toBe(false);
  });

  test("NEVER touches the user's own files", () => {
    // This runs against the user's real ~/.codex, so the blast radius of a
    // wrong glob is their credentials.
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6-terra"');
    writeFileSync(join(home, "history.jsonl"), "{}");
    writeFileSync(join(home, "my-apiary-notes.md"), "mine");
    writeFileSync(join(home, "apiary.config.toml"), "not ours — no dash");
    mkdirSync(join(home, "sessions"), { recursive: true });

    pruneCodexProfiles([], home);

    for (const kept of ["auth.json", "config.toml", "history.jsonl", "my-apiary-notes.md", "apiary.config.toml"]) {
      expect(existsSync(join(home, kept))).toBe(true);
    }
    expect(existsSync(join(home, "sessions"))).toBe(true);
  });

  test("leaves another tool's profile alone", () => {
    writeFileSync(join(home, "work.config.toml"), "model = \"x\"");
    pruneCodexProfiles([], home);
    expect(existsSync(join(home, "work.config.toml"))).toBe(true);
  });

  test("a missing Codex home is not an error", () => {
    expect(pruneCodexProfiles([], join(home, "nope"))).toBe(0);
  });

  test("nothing to prune returns 0", () => {
    prepareCodexLaunch("alive", MCP_URL, [], home);
    expect(pruneCodexProfiles(["alive"], home)).toBe(0);
  });
});

describe("config resolution", () => {
  test("APIARY_CODEX_TOOL_APPROVAL overrides the default", () => {
    expect(codexToolApprovalMode({ APIARY_CODEX_TOOL_APPROVAL: "ask" } as NodeJS.ProcessEnv)).toBe("ask");
    expect(codexToolApprovalMode({} as NodeJS.ProcessEnv)).toBe("approve");
    expect(codexToolApprovalMode({ APIARY_CODEX_TOOL_APPROVAL: "  " } as NodeJS.ProcessEnv)).toBe("approve");
  });

  test("userCodexHome honours CODEX_HOME, else ~/.codex", () => {
    expect(userCodexHome({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe("/custom/codex");
    expect(userCodexHome({} as NodeJS.ProcessEnv)).toMatch(/\.codex$/);
    expect(userCodexHome({ CODEX_HOME: "   " } as NodeJS.ProcessEnv)).toMatch(/\.codex$/);
  });
});

describe("RUNTIME_TOOL_NAMES", () => {
  test("matches the tools actually registered on the runtime MCP server", () => {
    // Drift guard: a tool added to runtime.ts but not to RUNTIME_TOOL_NAMES
    // would silently go back to prompting for approval.
    const src = readFileSync(new URL("../src/agent/mcp/runtime.ts", import.meta.url), "utf-8");
    const body = src.slice(src.indexOf("function registerTools"));
    const registered = new Set(
      [...body.matchAll(/server\.tool\(\s*"(apiary__[a-z_]+)"/g)].map((m) => m[1]),
    );

    expect(registered.size).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...RUNTIME_TOOL_NAMES].sort());
  });
});
