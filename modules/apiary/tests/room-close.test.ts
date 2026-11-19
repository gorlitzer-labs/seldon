import { describe, test, expect } from "vitest";
import { shouldIdleClose, DEFAULT_IDLE_CLOSE_MS } from "../src/cli/serve.js";
import { can } from "../src/core/authority.js";

const H = 3_600_000;

describe("idle auto-close", () => {
  test("closes once nobody has been in the room for the idle window", () => {
    expect(shouldIdleClose({ now: 13 * H, lastHumanActivityAt: 0, humanPresent: false, idleCloseMs: 12 * H })).toBe(true);
  });
  test("stays open just inside the window", () => {
    expect(shouldIdleClose({ now: 11 * H, lastHumanActivityAt: 0, humanPresent: false, idleCloseMs: 12 * H })).toBe(false);
  });
  test("a person connected always keeps it open, however old the last message", () => {
    expect(shouldIdleClose({ now: 100 * H, lastHumanActivityAt: 0, humanPresent: true, idleCloseMs: 12 * H })).toBe(false);
  });
  test("0 turns it off", () => {
    expect(shouldIdleClose({ now: 1e12, lastHumanActivityAt: 0, humanPresent: false, idleCloseMs: 0 })).toBe(false);
  });
  test("default is 12h", () => {
    expect(DEFAULT_IDLE_CLOSE_MS).toBe(12 * H);
  });
});

describe("close_room authority", () => {
  test("admin only", () => {
    expect(can("admin", "close_room")).toBe(true);
    expect(can("product_owner", "close_room")).toBe(false);
    expect(can("member", "close_room")).toBe(false);
    expect(can("guest", "close_room")).toBe(false);
  });
});
