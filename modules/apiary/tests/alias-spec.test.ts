/** Tests for parseAliasSpec — the name:tier:type:model wizard grammar. */

import { describe, test, expect } from "vitest";
import { parseAliasSpec } from "../src/cli/room.js";

describe("parseAliasSpec", () => {
  test("bare alias → agent / member, no model", () => {
    expect(parseAliasSpec("cane")).toEqual({
      alias: "cane", type: "agent", tier: "member", role: "agent", model: undefined,
    });
  });

  test("recognizes tier tokens", () => {
    expect(parseAliasSpec("cane:owner")?.tier).toBe("product_owner");
    expect(parseAliasSpec("cane:admin")?.tier).toBe("admin");
    expect(parseAliasSpec("cane:guest")?.tier).toBe("guest");
  });

  test("recognizes type tokens", () => {
    expect(parseAliasSpec("bob:human")?.type).toBe("human");
  });

  test("recognizes short model tokens", () => {
    expect(parseAliasSpec("bf:opus")?.model).toBe("opus");
    expect(parseAliasSpec("anvil:sonnet")?.model).toBe("sonnet");
    expect(parseAliasSpec("husk:haiku")?.model).toBe("haiku");
  });

  test("recognizes full claude model IDs", () => {
    expect(parseAliasSpec("bf:claude-sonnet-4-6")?.model).toBe("claude-sonnet-4-6");
    expect(parseAliasSpec("anvil:claude-opus-4-7")?.model).toBe("claude-opus-4-7");
  });

  test("combines tier + model in either order", () => {
    expect(parseAliasSpec("bf:admin:opus")).toMatchObject({ tier: "admin", model: "opus" });
    expect(parseAliasSpec("bf:opus:admin")).toMatchObject({ tier: "admin", model: "opus" });
  });

  test("unknown token becomes role label (back-compat)", () => {
    expect(parseAliasSpec("bf:reviewer")?.role).toBe("reviewer");
  });

  test("empty/whitespace input returns null", () => {
    expect(parseAliasSpec("")).toBeNull();
    expect(parseAliasSpec("   ")).toBeNull();
    expect(parseAliasSpec(":::")).toBeNull();
  });

  test("filters empty segments from double colons", () => {
    expect(parseAliasSpec("bf::opus")?.model).toBe("opus");
  });
});
