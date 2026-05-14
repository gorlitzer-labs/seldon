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
 * go through `levelOf()`.
 */
export const TIER_ORDER: Record<AuthorityLevel, number> = {
  guest:         0,
  member:        1,
  product_owner: 2,
  admin:         3,
};

/** Numeric position of a tier. Higher = more privilege. */
export function levelOf(a: AuthorityLevel): number {
  return TIER_ORDER[a];
}

/** Does `actual` meet or exceed `required`? Use for raw-tier comparisons. */
export function hasAuthority(actual: AuthorityLevel | undefined, required: AuthorityLevel): boolean {
  if (!actual) return false;
  return TIER_ORDER[actual] >= TIER_ORDER[required];
}

/** Can the bearer of `authority` perform `op`? The check everyone calls. */
export function can(authority: AuthorityLevel | undefined, op: Operation): boolean {
  if (!authority) return false;
  return TIER_ORDER[authority] >= TIER_ORDER[MIN_AUTHORITY[op]];
}

/**
 * Can `caller` grant a token / promote someone to `target` tier?
 *
 * Strictly `>` — a product_owner cannot promote anyone to product_owner (only
 * admins can). Closes the lateral-escalation door. Note: `canGrant` in
 * src/cli/auth.ts handles share-token generation with slightly more permissive
 * semantics (members can clone their own tier); this helper is for operations
 * that change someone *else's* authority.
 */
export function canGrantTier(caller: AuthorityLevel | undefined, target: AuthorityLevel): boolean {
  if (!caller) return false;
  return TIER_ORDER[caller] > TIER_ORDER[target];
}

/** The minimum authority required for an operation — exported for docs/help text. */
export function minAuthorityFor(op: Operation): AuthorityLevel {
  return MIN_AUTHORITY[op];
}
