/**
 * The room's founding tokens must outlive any TTL.
 *
 * They are written into ~/.apiary/sessions and are the only recorded way back
 * into a running room. When they expired at 24h the owner was locked out of a
 * room that was still serving, with agents still working inside it, and
 * `apiary room resume` said only "Invalid share token".
 */

import { describe, test, expect } from "vitest";
import { TokenManager } from "../src/cli/auth.js";
import { readFileSync } from "node:fs";

/** A manager whose share tokens die almost immediately, to age them in a test. */
function shortLived() {
  return new TokenManager({ shareTtlMs: 10 });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("founding room tokens", () => {
  test("a founding token still validates long after the TTL has passed", async () => {
    const t = shortLived();
    const founding = t.generateShareToken("admin", "admin", { neverExpires: true })!;
    await tick(40);
    expect(t.validateShareToken(founding)).toBe("admin");
  });

  test("an ordinary /share link still expires — the TTL is not simply gone", async () => {
    // The fix must not become "nothing expires". A handed-out link is a
    // genuine hand-out and should still age.
    const t = shortLived();
    const link = t.generateShareToken("admin", "member")!;
    expect(t.validateShareToken(link)).toBe("member");
    await tick(40);
    expect(t.validateShareToken(link)).toBeNull();
  });

  test("pruneExpired does not sweep away a founding token", () => {
    // `now > null` is true in JS, so an unguarded sweep deletes every
    // never-expiring token on its first pass and silently undoes the fix.
    const t = shortLived();
    const founding = t.generateShareToken("admin", "member", { neverExpires: true })!;
    t.pruneExpired();
    expect(t.validateShareToken(founding)).toBe("member");
  });

  test("pruneExpired still sweeps an ordinary expired link", async () => {
    const t = shortLived();
    const link = t.generateShareToken("admin", "member")!;
    await tick(40);
    t.pruneExpired();
    expect(t.validateShareToken(link)).toBeNull();
  });

  test("never-expiring does not grant authority the caller lacks", () => {
    // The flag changes lifetime, nothing else. A member must not be able to
    // mint an immortal admin token.
    expect(new TokenManager().generateShareToken("member", "admin", { neverExpires: true })).toBeNull();
  });

  test("both of the room's founding tokens survive, at their own tiers", async () => {
    // Exactly what serve.ts mints at startup and writes to the room record.
    const t = shortLived();
    const admin = t.generateShareToken("admin", "admin", { neverExpires: true })!;
    const member = t.generateShareToken("admin", "member", { neverExpires: true })!;
    await tick(40);
    t.pruneExpired();
    expect(t.validateShareToken(admin)).toBe("admin");
    expect(t.validateShareToken(member)).toBe("member");
  });

  // ── The wiring ─────────────────────────────────────────────────────────
  //
  // Everything above tests TokenManager. None of it notices if serve.ts stops
  // ASKING for a non-expiring token — that mutant was run and it survived with
  // all 590 tests green while the lockout was fully restored.
  test("serve.ts mints both founding tokens as never-expiring", () => {
    const src = readFileSync("src/cli/serve.ts", "utf-8");
    for (const tier of ["admin", "member"]) {
      const call = src.match(
        new RegExp(`const ${tier}Token = tokens\\.generateShareToken\\(([^;]*)\\)!`),
      );
      expect(call, `the ${tier} founding token mint moved or was renamed`).not.toBeNull();
      expect(call![1], `${tier} founding token must not expire`).toContain("neverExpires: true");
    }
  });
});
