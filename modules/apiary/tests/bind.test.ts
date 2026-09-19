/**
 * Tests for which interface a room listens on and which address it advertises.
 *
 * The two failure modes this guards against, both of which bit the previous
 * `--expose` behaviour on a laptop with Tailscale up:
 *
 *   1. Binding wider than intended — 0.0.0.0 puts the room on whatever
 *      untrusted network the machine happens to join.
 *   2. Advertising an address clients cannot reach — "the first non-internal
 *      IPv4" is often the home LAN, so the join link dies the moment you
 *      leave the house, which is exactly when you want it from a phone.
 */

import { describe, test, expect } from "vitest";

import {
  isTailnetAddress,
  resolveBindAddress,
  advertisedAddress,
  localAddresses,
  tailnetAddress,
  lanAddress,
  ALL_INTERFACES,
  LOOPBACK,
} from "../src/cli/bind.js";

describe("isTailnetAddress", () => {
  test("accepts the whole CGNAT range Tailscale uses (100.64.0.0/10)", () => {
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.112.183.19")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
  });

  test("rejects addresses just outside the range", () => {
    // 100.x is only a tailnet address for x in 64..127 — 100.0.x.x and
    // 100.128.x.x are ordinary public space.
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
    expect(isTailnetAddress("100.128.0.0")).toBe(false);
    expect(isTailnetAddress("101.64.0.1")).toBe(false);
  });

  test("rejects the private ranges it must not be confused with", () => {
    expect(isTailnetAddress("192.168.1.72")).toBe(false);
    expect(isTailnetAddress("10.0.0.1")).toBe(false);
    expect(isTailnetAddress("172.16.0.1")).toBe(false);
    expect(isTailnetAddress("127.0.0.1")).toBe(false);
  });

  test("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "100", "100.64", "100.64.0", "100.64.0.0.1", "abc", "100.64.0.x", "300.64.0.1"]) {
      expect(isTailnetAddress(bad), bad).toBe(false);
    }
  });
});

describe("resolveBindAddress aliases", () => {
  test("localhost", () => {
    expect(resolveBindAddress("localhost")).toMatchObject({ ok: true, address: LOOPBACK });
    expect(resolveBindAddress("127.0.0.1")).toMatchObject({ ok: true, address: LOOPBACK });
  });

  test("all interfaces, and it says so", () => {
    const res = resolveBindAddress("all");
    expect(res).toMatchObject({ ok: true, address: ALL_INTERFACES });
    // The widest option should announce its own blast radius.
    expect(res.ok && res.note).toMatch(/untrusted/i);
  });

  test("tailscale, when a tailnet address exists on this machine", () => {
    const expected = tailnetAddress();
    for (const alias of ["tailscale", "tailnet", "ts", "TAILSCALE"]) {
      const res = resolveBindAddress(alias);
      if (expected) {
        expect(res, alias).toMatchObject({ ok: true, address: expected });
      } else {
        // No Tailscale here — must fail with a pointer, not bind something else.
        expect(res.ok, alias).toBe(false);
        expect(!res.ok && res.error).toMatch(/tailscale/i);
      }
    }
  });

  test("lan never resolves to the tailnet address", () => {
    const res = resolveBindAddress("lan");
    if (res.ok) expect(isTailnetAddress(res.address)).toBe(false);
  });

  test("a literal address on this machine is accepted", () => {
    const own = localAddresses()[0];
    if (!own) return;
    expect(resolveBindAddress(own.address)).toMatchObject({ ok: true, address: own.address });
  });

  test("an address NOT on this machine is refused, with the options listed", () => {
    // Passing it to listen() would fail later as a bare EADDRNOTAVAIL, long
    // after the context that would explain it.
    const res = resolveBindAddress("10.99.99.99");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("not an address on this machine");
    expect(!res.ok && res.error).toMatch(/tailscale, lan, all, localhost/);
  });

  test("an unknown alias is refused, not silently treated as a hostname", () => {
    expect(resolveBindAddress("wifi").ok).toBe(false);
    expect(resolveBindAddress("").ok).toBe(false);
    expect(resolveBindAddress("   ").ok).toBe(false);
  });

  test("surrounding whitespace is tolerated", () => {
    expect(resolveBindAddress("  localhost  ")).toMatchObject({ ok: true, address: LOOPBACK });
  });
});

describe("advertisedAddress", () => {
  test("a specific bind is advertised verbatim", () => {
    expect(advertisedAddress("100.112.183.19")).toBe("100.112.183.19");
    expect(advertisedAddress(LOOPBACK)).toBe(LOOPBACK);
  });

  test("0.0.0.0 is never advertised — it is not dialable", () => {
    expect(advertisedAddress(ALL_INTERFACES)).not.toBe(ALL_INTERFACES);
  });

  test("0.0.0.0 prefers the tailnet address when there is one", () => {
    // A link that works from a phone anywhere beats one that works only on
    // this wifi.
    const expected = tailnetAddress() ?? lanAddress() ?? LOOPBACK;
    expect(advertisedAddress(ALL_INTERFACES)).toBe(expected);
  });
});

describe("localAddresses", () => {
  test("never includes loopback", () => {
    for (const a of localAddresses()) expect(a.address).not.toBe(LOOPBACK);
  });

  test("reports the owning interface, for error messages", () => {
    for (const a of localAddresses()) expect(a.iface.length).toBeGreaterThan(0);
  });
});

describe("interface order does not change the answer", () => {
  // The bug being guarded: "the first non-internal IPv4" depends on OS
  // interface order, so the same code picked the LAN on one machine and the
  // tailnet on another. These pass an explicit order, in both arrangements.
  const TS = { iface: "utun0", address: "100.112.183.19" };
  const LAN = { iface: "en0", address: "192.168.1.72" };

  test("tailnetAddress finds the tailnet whichever way round they are listed", () => {
    expect(tailnetAddress([LAN, TS])).toBe(TS.address);
    expect(tailnetAddress([TS, LAN])).toBe(TS.address);
  });

  test("lanAddress skips the tailnet even when it is listed FIRST", () => {
    // This is the case a machine-dependent test cannot catch: on a box where
    // en0 happens to come first, "just take the first" looks correct.
    expect(lanAddress([TS, LAN])).toBe(LAN.address);
    expect(lanAddress([LAN, TS])).toBe(LAN.address);
  });

  test("lanAddress is null when the only address is a tailnet one", () => {
    expect(lanAddress([TS])).toBeNull();
  });

  test("tailnetAddress is null when Tailscale is down", () => {
    expect(tailnetAddress([LAN])).toBeNull();
  });

  test("0.0.0.0 advertises the tailnet even when the LAN is listed first", () => {
    expect(advertisedAddress(ALL_INTERFACES, [LAN, TS])).toBe(TS.address);
  });

  test("0.0.0.0 falls back to the LAN, then loopback", () => {
    expect(advertisedAddress(ALL_INTERFACES, [LAN])).toBe(LAN.address);
    expect(advertisedAddress(ALL_INTERFACES, [])).toBe(LOOPBACK);
  });
});
