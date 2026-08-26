/**
 * Centralized authority tier model.
 *
 * Four ordered tiers — admin > product_owner > member > guest — gate every
 * privileged operation. Historically each call site had its own
 * `authority === "admin" || authority === "product_owner"` chain. That style
 * drifted (product_owner was silently excluded from /mute autocomplete; the
 * MCP runtime gated admin tools on a static CLI flag instead of the
 * server-granted tier; etc.) and is exactly the kind of bug that recurs when
 * a 5th tier eventually lands.
 *
 * One table here. Every call site reads from it. Adding an operation = one
 * row. Adding a tier = one entry in `TIER_ORDER`. No more scattered string
 * comparisons.
 */

import type { AuthorityLevel } from "./types.js";

/** Every operation the system gates. Keep this list narrow — it's the surface. */
export type Operation =
  // Member-and-up — basic participation
  | "send_message"
  | "set_own_mode"
  | "ping"
  | "create_share_link"
  // Product owner-and-up — room management
  | "mute"
  | "unmute"
  | "set_mode_for"
  // Admin-only — destructive or escalation
  | "kick"
  | "clear_history"
  | "start_tunnel"
  | "promote"
  | "demote";

/**
 * The single source of truth. Adding a new operation = one row here; the gate
 * is automatically enforceable everywhere via `can()`.
 */
const MIN_AUTHORITY: Record<Operation, AuthorityLevel> = {
  send_message:      "member",
  set_own_mode:      "member",
  ping:              "member",
  create_share_link: "member",

  mute:              "product_owner",
  unmute:            "product_owner",
  set_mode_for:      "product_owner",

  kick:              "admin",
  clear_history:     "admin",
  start_tunnel:      "admin",
  promote:           "admin",
  demote:            "admin",
};

/**
 * Numeric ordering. Authority strings MUST NOT be compared with `<`/`>`
 * directly — lexical ordering "p" > "m" makes `"product_owner" > "member"`
 * accidentally true and silently breaks the moment any string changes. Always
 * go through `TIER_ORDER`.
 */
export const TIER_ORDER: Record<AuthorityLevel, number> = {
  guest:         0,
  member:        1,
  product_owner: 2,
  admin:         3,
};

/** Can the bearer of `authority` perform `op`? The check everyone calls. */
export function can(authority: AuthorityLevel | undefined, op: Operation): boolean {
  if (!authority) return false;
  return TIER_ORDER[authority] >= TIER_ORDER[MIN_AUTHORITY[op]];
}
