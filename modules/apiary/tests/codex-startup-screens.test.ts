/**
 * The two screens Codex shows before its composer — folder trust and the update menu.
 *
 * Found launching a background Codex agent into a folder it had not seen: it sat on
 * "Trust this folder?" forever, and after Codex 0.157 shipped, on "Update available"
 * too. Nobody watches that pane, so either is a permanent stall. The bridge also still
 * looked for the pre-0.156 wording, so it would have typed the room's first message
 * into the trust menu instead of waiting.
 *
 * The screen text below is copied from a real Codex 0.156.1 pane, not paraphrased.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareCodexLaunch, renderCodexProfile, trustDirsFor } from "../src/cli/codex/launch.js";
import { detectCodexStateFromLines } from "../src/cli/codex/tmux-bridge.js";

const MCP = "http://127.0.0.1:51475/mcp";

const TRUST_SCREEN = [
  "  Folder access",
  "  /Users/someone/Desktop/anatomy",
  "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.",
  "  trust these files. Your trust decision will be saved.",
  "› 1. Trust and continue",
  "  2. Quit",
  "  enter continue · esc quit",
];
const UPDATE_SCREEN = [
  "  Update available · 0.156.1 → 0.157.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "› 1. Update now (runs `brew upgrade --cask codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "  enter continue · esc skip",
];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "apiary_codex_startup_")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

describe("unattended Codex profile clears the pre-composer screens", () => {
  it("trusts the agent's own folder and turns off the startup update check", () => {
    const out = renderCodexProfile(MCP, "approve", true, ["/Users/someone/Desktop/anatomy"]);
    expect(out).toContain('[projects."/Users/someone/Desktop/anatomy"]\ntrust_level = "trusted"');
    expect(out).toContain("check_for_update_on_startup = false");
    // a top-level key after a table header would be parsed as a member of that table
    expect(out.indexOf("check_for_update_on_startup")).toBeLessThan(out.indexOf("["));
  });

  it("an attended agent gets neither: a human is there to answer", () => {
    const out = renderCodexProfile(MCP, "approve", false, ["/x"]);
    expect(out).not.toContain("[projects.");
    expect(out).not.toContain("check_for_update_on_startup");
  });

  it("a path with quotes or backslashes stays one valid TOML key", () => {
    const out = renderCodexProfile(MCP, "approve", true, ['/tmp/we"ird\\dir']);
    expect(out).toContain('[projects."/tmp/we\\"ird\\\\dir"]');
  });

  it("prepareCodexLaunch trusts the cwd as given and with symlinks resolved", () => {
    const real = mkdtempSync(join(dir, "real-"));
    const link = join(dir, "link");
    symlinkSync(real, link);
    const { profilePath } = prepareCodexLaunch("bee", MCP, [], dir, link);
    const body = readFileSync(profilePath, "utf8");
    expect(trustDirsFor(link)).toEqual([link, realpathSync(real)]);
    expect(body).toContain(`[projects.${JSON.stringify(link)}]`);
    expect(body).toContain(`[projects.${JSON.stringify(realpathSync(real))}]`);
  });
});

describe("the bridge recognises both screens as blocked", () => {
  it("current trust wording", () => {
    expect(detectCodexStateFromLines(TRUST_SCREEN)).toBe("blocked");
  });
  it("update menu", () => {
    expect(detectCodexStateFromLines(UPDATE_SCREEN)).toBe("blocked");
  });
});
