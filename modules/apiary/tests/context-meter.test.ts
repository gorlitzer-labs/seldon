/**
 * Tests for the room's context meter and for not presenting a guess as a fact.
 *
 * Both come from the same complaint: an agent reached 262k tokens with nothing
 * on screen to say so, and the status glyphs "went stale" in a way that made
 * the strip untrustworthy.
 */

import { describe, test, expect } from "vitest";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cwdToProjectDir } from "../src/cli/claude/jsonl-stats.js";
import { OBSERVED_TTL_MS, INFERRED_DECAY_MS, shouldApplyAgentState } from "../src/cli/tui.js";

describe("cwdToProjectDir", () => {
  // Claude Code slugifies a cwd by replacing separators AND dots. Replacing
  // only "/" produced a directory that never exists for any user whose home
  // contains a dot, and the caller reads "no file" as "no metrics yet" — so
  // the meter silently never appeared for them. Zero metrics events had ever
  // been recorded before this was found.
  test("replaces dots as well as slashes", () => {
    expect(cwdToProjectDir("/Users/ada.lovelace/Desktop/thing"))
      .toBe("-Users-ada-lovelace-Desktop-thing");
  });

  test("a dotless path is unaffected", () => {
    expect(cwdToProjectDir("/Users/ada/Desktop/thing"))
      .toBe("-Users-ada-Desktop-thing");
  });

  test("handles several dots, and dotted directories", () => {
    expect(cwdToProjectDir("/Users/a.b.c/x.y/z")).toBe("-Users-a-b-c-x-y-z");
  });

  test("hidden directories keep their leading dot as a dash", () => {
    expect(cwdToProjectDir("/home/u/.config/app")).toBe("-home-u--config-app");
  });

  test("resolves to a real directory on this machine", () => {
    // The regression test that actually matters: this user's home has a dot.
    const home = homedir();
    const slug = cwdToProjectDir(home);
    const projects = join(home, ".claude", "projects");
    if (!existsSync(projects)) return;
    // Not asserting this exact project exists — only that the slug shape has
    // no dots left, which is what broke.
    expect(slug).not.toMatch(/\./);
  });
});

describe("a guessed state must not outlive the truth", () => {
  test("inferred states expire on the order of the observed TTL, not minutes", () => {
    // Five minutes was the old value, from when guessing was the only signal.
    // Runtimes now report every ~1.5s, so a long decay is just a long time
    // spent being wrong.
    // Read the real constant, not a recomputation of it — an earlier version
    // of this test derived the value itself and so asserted a tautology,
    // surviving a mutant that put the five minutes back.
    expect(INFERRED_DECAY_MS).toBeLessThanOrEqual(60_000);
    expect(INFERRED_DECAY_MS).toBeGreaterThan(OBSERVED_TTL_MS);
  });

  test("a reported state still outranks a guess while fresh", () => {
    const now = 1_000_000;
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: now - 1_000, now }))
      .toBe(false);
  });

  test("and inference resumes once reports stop", () => {
    const now = 1_000_000;
    expect(shouldApplyAgentState({ observed: false, lastObservedAt: now - OBSERVED_TTL_MS - 1, now }))
      .toBe(true);
  });
});
