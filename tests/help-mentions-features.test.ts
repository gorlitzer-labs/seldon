/**
 * The CLI's own help must mention the features that exist.
 *
 * Five releases shipped flags and commands while `apiary --help` kept
 * describing an older version. README.md and CLAUDE.md were updated each time;
 * the help text — the one place a user actually looks, and the only one
 * available offline — was not.
 *
 * These assert the RENDERED output of the real binary, not the source. An
 * earlier version of this file grepped src/cli/index.ts, which passed happily
 * when the help lines were removed, because the same flag strings still
 * appeared in the argument parser. "The string exists somewhere in the file"
 * is not the property worth guarding.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI = resolve(__dirname, "../dist/cli/index.js");
const HAS_BUILD = existsSync(CLI);

/** SGR escape sequences, so assertions can read the words a user sees. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function run(...args: string[]): string {
  const out = execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return out.replace(ANSI, "");
}

let help = "";
let examples = "";

beforeAll(() => {
  if (!HAS_BUILD) return;
  help = run("--help");
  examples = run("examples");
});

/** Everything a user can type or pass that we expect the help to document. */
const SURFACES: Array<{ surface: string; since: string }> = [
  { surface: "--bind",    since: "v1.9.0 — which interface the room listens on" },
  { surface: "tailscale", since: "v1.9.0 — the alias people actually want" },
  { surface: "--mode",    since: "v1.7.0 — per-agent engagement" },
  { surface: "standby",   since: "v1.7.0 — quiet until addressed" },
  { surface: "/watch",    since: "v1.6.0 — open an agent's terminal" },
  { surface: "needs you", since: "v1.6.0 — the blocked-agent state" },
  { surface: "--share",   since: "public tunnel" },
  { surface: "--admin",   since: "authority tiers" },
  { surface: "/setmode",  since: "change engagement live" },
  { surface: "/ping",     since: "status check" },
];

describe.skipIf(!HAS_BUILD)("the help output mentions what exists", () => {
  test.each(SURFACES)("mentions $surface ($since)", ({ surface }) => {
    expect(`${help}\n${examples}`).toContain(surface);
  });
});

describe.skipIf(!HAS_BUILD)("the help stays honest about defaults", () => {
  test("says the room is local-only unless told otherwise", () => {
    // Getting this wrong is invisible until a join link fails from elsewhere.
    expect(help).toMatch(/this machine only/i);
  });

  test("explains what a tailnet bind actually means", () => {
    // "bind tailscale" is not self-explanatory; who can reach it is the point.
    expect(help).toMatch(/not the local network/i);
  });

  test("explains standby rather than just naming it", () => {
    expect(help).toMatch(/@mention/);
  });

  test("names the agent states the strip shows", () => {
    expect(help).toMatch(/idle/);
    expect(help).toMatch(/working/);
  });
});

describe.skipIf(!HAS_BUILD)("the help is usable", () => {
  test("--help and examples both produce real output", () => {
    expect(help.length).toBeGreaterThan(400);
    expect(examples.length).toBeGreaterThan(400);
  });

  test("the version shown matches package.json", () => {
    // A stale version in the banner is the same class of drift.
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
    ) as { version: string };
    expect(help).toContain(pkg.version);
  });
});
