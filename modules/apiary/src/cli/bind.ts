/**
 * Which network interface a room server listens on, and which address it
 * advertises in join links.
 *
 * `--expose` binds 0.0.0.0 and advertises the first non-internal IPv4 the OS
 * happens to list. That is wrong in both directions on a laptop that is on a
 * VPN: the room ends up reachable from whatever café wifi you are on, while
 * the join link points at a home-LAN address that is dead the moment you
 * leave the house.
 *
 * `--bind` fixes both by naming the interface. The common case is a tailnet:
 *
 *   apiary room hive --bind tailscale
 *
 * which listens only on the Tailscale interface and mints join links against
 * the tailnet address — reachable from your phone anywhere, invisible to the
 * local network, with Tailscale doing the identity. No public tunnel, and no
 * bearer token in a URL that traverses the internet.
 */

import { networkInterfaces } from "node:os";

/** An IPv4 address on this machine, with the interface that owns it. */
export interface LocalAddress {
  iface: string;
  address: string;
}

/**
 * Tailscale hands out addresses from 100.64.0.0/10 — the CGNAT range reserved
 * by RFC 6598 for carrier NAT, which Tailscale reuses for tailnets because it
 * will not collide with normal private ranges (10/8, 172.16/12, 192.168/16).
 * That makes "is this a tailnet address?" a reliable test rather than a guess
 * at interface names, which differ across platforms (utun on macOS,
 * tailscale0 on Linux).
 */
export function isTailnetAddress(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  // 100.64.0.0/10 → first octet 100, second octet 64-127.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Every non-loopback IPv4 address on this machine, in OS order. */
export function localAddresses(): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push({ iface, address: addr.address });
    }
  }
  return out;
}

/**
 * This machine's tailnet address, or null if Tailscale is not up.
 *
 * `addrs` is injectable so the interface-ordering behaviour can be tested
 * deterministically — on a real machine the order is whatever the OS reports,
 * which is precisely the thing that made `--expose` unpredictable.
 */
export function tailnetAddress(addrs: LocalAddress[] = localAddresses()): string | null {
  return addrs.find((a) => isTailnetAddress(a.address))?.address ?? null;
}

/**
 * This machine's LAN address — the first non-loopback IPv4 that is NOT a
 * tailnet address.
 *
 * Excluding the tailnet matters: on a machine with Tailscale up, "the first
 * non-internal IPv4" can be either one depending on interface order, so
 * without the filter `--bind lan` would sometimes silently mean `tailscale`.
 */
export function lanAddress(addrs: LocalAddress[] = localAddresses()): string | null {
  return addrs.find((a) => !isTailnetAddress(a.address))?.address ?? null;
}

export const ALL_INTERFACES = "0.0.0.0";
export const LOOPBACK = "127.0.0.1";

export type BindResolution =
  | { ok: true; address: string; note?: string }
  | { ok: false; error: string };

/**
 * Turn a `--bind` value into an address to listen on.
 *
 * Accepts the aliases `tailscale`/`ts`, `lan`, `all`, and `localhost`, or a
 * literal address. A literal that is not present on this machine is rejected
 * rather than passed to `listen()`, which would otherwise fail with a bare
 * EADDRNOTAVAIL long after the useful context is gone.
 */
export function resolveBindAddress(spec: string): BindResolution {
  const value = spec.trim();
  if (!value) return { ok: false, error: "empty --bind value" };

  switch (value.toLowerCase()) {
    case "tailscale":
    case "tailnet":
    case "ts": {
      const address = tailnetAddress();
      if (!address) {
        return {
          ok: false,
          error: "no Tailscale address found (100.64.0.0/10). Is Tailscale up? Check with: tailscale ip -4",
        };
      }
      return { ok: true, address, note: "tailnet — reachable from your other tailnet devices only" };
    }

    case "lan": {
      const address = lanAddress();
      if (!address) return { ok: false, error: "no LAN address found on this machine" };
      return { ok: true, address, note: "LAN — reachable from this network only" };
    }

    case "all":
    case "any":
    case ALL_INTERFACES:
      return {
        ok: true,
        address: ALL_INTERFACES,
        note: "ALL interfaces — including any untrusted network this machine joins",
      };

    case "localhost":
    case LOOPBACK:
      return { ok: true, address: LOOPBACK, note: "this machine only" };

    default:
      break;
  }

  const owner = localAddresses().find((a) => a.address === value);
  if (!owner) {
    const available = localAddresses().map((a) => `${a.address} (${a.iface})`).join(", ");
    return {
      ok: false,
      error: `"${value}" is not an address on this machine.`
        + (available ? ` Available: ${available}` : "")
        + ` Or use: tailscale, lan, all, localhost.`,
    };
  }
  return {
    ok: true,
    address: value,
    note: isTailnetAddress(value)
      ? `tailnet (${owner.iface}) — reachable from your other tailnet devices only`
      : `${owner.iface}`,
  };
}

/**
 * The address to put in join links, given what the server bound to.
 *
 * 0.0.0.0 is not routable, so it has to be translated to something a client
 * can dial: prefer the tailnet address if there is one, since a link that
 * works from a phone anywhere beats one that works only on this wifi.
 */
export function advertisedAddress(
  bound: string,
  addrs: LocalAddress[] = localAddresses(),
): string {
  if (bound !== ALL_INTERFACES) return bound;
  return tailnetAddress(addrs) ?? lanAddress(addrs) ?? LOOPBACK;
}
