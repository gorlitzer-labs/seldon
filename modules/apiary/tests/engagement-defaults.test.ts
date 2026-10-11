/**
 * Tests for per-agent engagement mode: the alias grammar, CLI validation, and
 * the wizard's "first agent listens, the rest stay quiet" default.
 *
 * The default exists because in an active mode every agent evaluates every
 * message — an unaddressed remark in a room of five costs five agent turns and
 * produces five answers to one question. Blanket standby is the wrong cure: a
 * room that ignores you until you remember to @mention somebody.
 */

import { describe, test, expect } from "vitest";

import { parseAliasSpec, applyDefaultModes } from "../src/cli/room.js";
import { parseEngagementMode, ENGAGEMENT_MODE_NAMES } from "../src/agent/engagement.js";

const agent = (mode?: string) => ({ role: "agent", mode: mode as never });
const human = () => ({ role: "human", mode: undefined });

describe("alias grammar: mode suffix", () => {
  test(":standby is shorthand for standby-everyone", () => {
    expect(parseAliasSpec("cane:standby")?.mode).toBe("standby-everyone");
  });

  test("full mode names pass through", () => {
    expect(parseAliasSpec("cane:standby-people")?.mode).toBe("standby-people");
    expect(parseAliasSpec("cane:standby-agents")?.mode).toBe("standby-agents");
    expect(parseAliasSpec("cane:active")?.mode).toBe("everyone");
  });

  test("no mode suffix leaves it unset, for the default to fill in", () => {
    expect(parseAliasSpec("cane")?.mode).toBeUndefined();
  });

  test("composes with the other axes, in any order", () => {
    const spec = parseAliasSpec("anvil:sonnet:owner:standby");
    expect(spec).toMatchObject({
      alias: "anvil",
      tier: "product_owner",
      model: "sonnet",
      mode: "standby-everyone",
    });
  });

  test("a mode token is not swallowed as a cosmetic role label", () => {
    // Unrecognised tokens become the role, so the mode check has to come first.
    expect(parseAliasSpec("cane:standby")?.role).not.toBe("standby");
  });

  test("an unrelated suffix is still a role label", () => {
    expect(parseAliasSpec("cane:reviewer")?.role).toBe("reviewer");
    expect(parseAliasSpec("cane:reviewer")?.mode).toBeUndefined();
  });
});

describe("parseEngagementMode", () => {
  test("accepts every real mode", () => {
    for (const mode of ENGAGEMENT_MODE_NAMES) {
      expect(parseEngagementMode(mode)).toBe(mode);
    }
  });

  test("accepts the standby shorthand and is case-insensitive", () => {
    expect(parseEngagementMode("standby")).toBe("standby-everyone");
    expect(parseEngagementMode("STANDBY-PEOPLE")).toBe("standby-people");
  });

  test("a typo falls back to the default rather than an unchosen mode", () => {
    // Silently starting an agent in "standby-agents" because someone typed
    // "standy" would look exactly like the agent being broken.
    expect(parseEngagementMode("standy")).toBeUndefined();
    expect(parseEngagementMode("quiet")).toBeUndefined();
    expect(parseEngagementMode("")).toBeUndefined();
    expect(parseEngagementMode(undefined)).toBeUndefined();
  });
});

describe("applyDefaultModes", () => {
  test("first agent listens, the rest stay quiet", () => {
    const ps = [agent(), agent(), agent()];
    applyDefaultModes(ps);
    expect(ps.map((p) => p.mode)).toEqual(["everyone", "standby-everyone", "standby-everyone"]);
  });

  test("a solo agent is left listening", () => {
    // Nothing to save, and a one-agent room that ignores you is just broken.
    const ps = [agent()];
    applyDefaultModes(ps);
    expect(ps[0].mode).toBe("everyone");
  });

  test("humans never get a mode", () => {
    const ps = [human(), agent(), agent()];
    applyDefaultModes(ps);
    expect(ps[0].mode).toBeUndefined();
    expect(ps[1].mode).toBe("everyone");
    expect(ps[2].mode).toBe("standby-everyone");
  });

  test("a human first in the list does not consume the listener slot", () => {
    const ps = [human(), agent()];
    applyDefaultModes(ps);
    expect(ps[1].mode).toBe("everyone");
  });

  test("an explicit mode always wins", () => {
    const ps = [agent("standby-people"), agent()];
    applyDefaultModes(ps);
    expect(ps[0].mode).toBe("standby-people");
    // First agent asked to be quiet, so the next one becomes the listener.
    expect(ps[1].mode).toBe("everyone");
  });

  test("an explicitly active agent claims the listener slot", () => {
    // Otherwise a second agent gets promoted and two answer everything.
    const ps = [agent(), agent("everyone")];
    applyDefaultModes(ps);
    expect(ps[0].mode).toBe("everyone");
    expect(ps[1].mode).toBe("everyone");

    const ps2 = [agent("everyone"), agent()];
    applyDefaultModes(ps2);
    expect(ps2.map((p) => p.mode)).toEqual(["everyone", "standby-everyone"]);
  });

  test("every agent explicitly standby is respected — nobody is promoted", () => {
    const ps = [agent("standby"), agent("standby-everyone")];
    applyDefaultModes(ps);
    expect(ps.map((p) => p.mode)).toEqual(["standby", "standby-everyone"]);
  });

  test("is idempotent", () => {
    const ps = [agent(), agent()];
    applyDefaultModes(ps);
    const first = ps.map((p) => p.mode);
    applyDefaultModes(ps);
    expect(ps.map((p) => p.mode)).toEqual(first);
  });

  test("an empty room is not an error", () => {
    expect(() => applyDefaultModes([])).not.toThrow();
  });
});
