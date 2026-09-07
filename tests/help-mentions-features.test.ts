/**
 * The CLI's own help must mention the features that exist.
 *
 * Five releases shipped flags and commands while `apiary --help` kept
 * describing an older version. README.md and CLAUDE.md were updated each time;
 * the help text — the one place a user actually looks, and the only one
 * available offline — was not.
 *
 * Two earlier versions of this file were wrong in instructive ways:
 *
 *   - It grepped src/cli/index.ts, and survived its own mutant: deleting the
 *     help lines still passed, because the same flag strings appear in the
 *     argument parser. "The string exists somewhere in the file" is not the
 *     property worth guarding.
 *   - It then spawned the BUILT binary, which made it depend on `dist/` being
 *     current — and `make release` runs the tests before the build, so any
 *     help change broke the release until dist was rebuilt by hand.
 *
 * So it now imports the help module and captures what it prints: the rendered
 * words a user sees, with no build step and no subprocess.
 */

import { describe, test, expect, beforeAll } from "vitest";

import { printUsage, printExamples } from "../src/cli/help.js";
import { getVersion } from "../src/cli/version.js";

/** Collect everything a print function emits. */
function capture(print: (stream: typeof console.log) => void): string {
  const out: string[] = [];
  print((...args: unknown[]) => { out.push(args.join(" ")); });
  return out.join("\n");
}

let help = "";
let examples = "";

beforeAll(() => {
  help = capture((stream) => printUsage(stream));
  // printExamples writes with console.log directly; swap it for the duration.
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { printExamples(); } finally { console.log = original; }
  examples = lines.join("\n");
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

describe("the help output mentions what exists", () => {
  test.each(SURFACES)("mentions $surface ($since)", ({ surface }) => {
    expect(`${help}\n${examples}`).toContain(surface);
  });
});

describe("the help stays honest about defaults", () => {
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

describe("the help is usable", () => {
  test("both surfaces produce real output", () => {
    expect(help.length).toBeGreaterThan(400);
    expect(examples.length).toBeGreaterThan(400);
  });

  test("the banner shows this package's version", () => {
    // A stale version in the banner is the same class of drift.
    expect(help).toContain(getVersion());
  });
});
