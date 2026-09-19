/**
 * Tests for the invite queue and its delivery loop.
 *
 * The invariant under test: an invite is only deleted once the agent is really
 * in the room. Deleting it on delivery strands an agent whose CLI was still on
 * a login or onboarding screen — the URL is gone and nothing can retry.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect the invite directory into a scratch dir so tests never touch ~/.apiary.
const INVITES_DIR = mkdtempSync(join(tmpdir(), "apiary_invites_test_"));

vi.mock("../src/cli/serve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/serve.js")>();
  return { ...actual, INVITES_DIR };
});

const {
  peekInvite,
  clearInvite,
  consumeInvite,
  invitePrompt,
  deliverInvite,
  sameApiaryServer,
} = await import("../src/cli/invites.js");

const URL_A = "http://127.0.0.1:7890/?token=abc123";

beforeEach(() => {
  mkdirSync(INVITES_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(INVITES_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeInvite(agent: string, url: string): string {
  const path = join(INVITES_DIR, agent);
  writeFileSync(path, url);
  return path;
}

/** Instant sleep — keeps the retry loop's wall-clock out of the test suite. */
const noSleep = async () => {};

describe("invite queue primitives", () => {
  test("peekInvite reads without deleting", () => {
    writeInvite("bee", URL_A);

    expect(peekInvite("bee")).toBe(URL_A);
    expect(peekInvite("bee")).toBe(URL_A);
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(true);
  });

  test("peekInvite trims trailing whitespace", () => {
    writeInvite("bee", `${URL_A}\n`);
    expect(peekInvite("bee")).toBe(URL_A);
  });

  test("peekInvite returns null for a missing or empty invite", () => {
    expect(peekInvite("nobody")).toBeNull();
    writeInvite("blank", "   \n");
    expect(peekInvite("blank")).toBeNull();
  });

  test("clearInvite deletes and is safe to repeat", () => {
    writeInvite("bee", URL_A);

    clearInvite("bee");
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
    expect(() => clearInvite("bee")).not.toThrow();
  });

  test("consumeInvite reads then deletes", () => {
    writeInvite("bee", URL_A);

    expect(consumeInvite("bee")).toBe(URL_A);
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
  });

  test("invitePrompt carries the URL the agent must call join_room with", () => {
    const parts = invitePrompt(URL_A);
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain("join_room");
    expect(parts[0].text).toContain(URL_A);
  });
});

describe("deliverInvite", () => {
  test("no invite queued — delivers nothing", async () => {
    const deliver = vi.fn();

    const outcome = await deliverInvite({
      agentName: "ghost",
      deliver,
      hasJoined: () => false,
      sleep: noSleep,
    });

    expect(outcome).toBe("no-invite");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("agent joins on the first ask — invite cleared", async () => {
    writeInvite("bee", URL_A);
    let joined = false;
    const deliver = vi.fn(() => { joined = true; });

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => joined,
      sleep: noSleep,
    });

    expect(outcome).toBe("joined");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0][0].text).toContain(URL_A);
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
  });

  test("agent stuck on a login screen — keeps asking, then joins", async () => {
    writeInvite("bee", URL_A);
    let attempts = 0;
    // Codex is on the sign-in menu for the first two asks; the human logs in
    // and the third ask lands on a real composer.
    const deliver = vi.fn(() => { attempts++; });

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => attempts >= 3,
      maxAttempts: 6,
      retryIntervalMs: 10,
      sleep: noSleep,
    });

    expect(outcome).toBe("joined");
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
  });

  test("agent never joins — invite is LEFT ON DISK for the next launch", async () => {
    writeInvite("bee", URL_A);
    const deliver = vi.fn();

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => false,
      maxAttempts: 3,
      retryIntervalMs: 10,
      sleep: noSleep,
    });

    expect(outcome).toBe("abandoned");
    expect(deliver).toHaveBeenCalledTimes(3);
    // The regression this whole change exists to prevent: losing the URL.
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(true);
    expect(readFileSync(join(INVITES_DIR, "bee"), "utf-8")).toBe(URL_A);
  });

  test("a throwing delivery does not abort the retry loop", async () => {
    writeInvite("bee", URL_A);
    let attempts = 0;
    const deliver = vi.fn(() => {
      attempts++;
      if (attempts === 1) throw new Error("pane is wedged");
    });

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => attempts >= 2,
      maxAttempts: 4,
      retryIntervalMs: 10,
      sleep: noSleep,
    });

    expect(outcome).toBe("joined");
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test("already in the room — clears without pestering the agent", async () => {
    writeInvite("bee", URL_A);
    const deliver = vi.fn();

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => true,
      sleep: noSleep,
    });

    expect(outcome).toBe("joined");
    expect(deliver).not.toHaveBeenCalled();
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
  });

  test("shutdown mid-loop — stops asking and keeps the invite", async () => {
    writeInvite("bee", URL_A);
    const controller = new AbortController();
    const deliver = vi.fn(() => { controller.abort(); });

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => false,
      maxAttempts: 5,
      retryIntervalMs: 10,
      signal: controller.signal,
      sleep: noSleep,
    });

    expect(outcome).toBe("cancelled");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(true);
  });

  test("already-aborted signal — never touches the agent", async () => {
    writeInvite("bee", URL_A);
    const controller = new AbortController();
    controller.abort();
    const deliver = vi.fn();

    const outcome = await deliverInvite({
      agentName: "bee",
      deliver,
      hasJoined: () => false,
      signal: controller.signal,
      sleep: noSleep,
    });

    expect(outcome).toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(true);
  });
});

describe("sameApiaryServer", () => {
  test("matches a join URL against the server it points at", () => {
    expect(sameApiaryServer("http://127.0.0.1:7890", URL_A)).toBe(true);
    expect(sameApiaryServer("http://127.0.0.1:7890/", URL_A)).toBe(true);
  });

  test("a different port is a different server", () => {
    expect(sameApiaryServer("http://127.0.0.1:7899", URL_A)).toBe(false);
  });

  test("a different host is a different server", () => {
    expect(sameApiaryServer("https://x.trycloudflare.com", URL_A)).toBe(false);
  });

  test("an unparseable URL errs toward clearing, not toward pestering", () => {
    // Never clearing would leave the runtime re-asking an agent that is
    // already in the room; clearing once too often costs a single auto-join.
    expect(sameApiaryServer("not a url", URL_A)).toBe(true);
  });
});

describe("deliverInvite room matching", () => {
  beforeEach(() => { writeInvite("bee", URL_A); });

  test("joining a DIFFERENT room does not clear the invite", () => {
    // Otherwise an agent told to join room B first would lose its invite to
    // room A and never auto-join the room it was actually spawned for.
    return deliverInvite({
      agentName: "bee",
      deliver: () => {},
      hasJoined: (url) => sameApiaryServer("http://127.0.0.1:9999", url),
      maxAttempts: 2,
      retryIntervalMs: 10,
      sleep: noSleep,
    }).then((outcome) => {
      expect(outcome).toBe("abandoned");
      expect(existsSync(join(INVITES_DIR, "bee"))).toBe(true);
    });
  });

  test("joining the invited room clears it", async () => {
    let joined = false;
    const outcome = await deliverInvite({
      agentName: "bee",
      deliver: () => { joined = true; },
      hasJoined: (url) => joined && sameApiaryServer("http://127.0.0.1:7890", url),
      maxAttempts: 2,
      retryIntervalMs: 10,
      sleep: noSleep,
    });

    expect(outcome).toBe("joined");
    expect(existsSync(join(INVITES_DIR, "bee"))).toBe(false);
  });

  test("hasJoined receives the invite URL, not something reconstructed", async () => {
    const seen: string[] = [];
    await deliverInvite({
      agentName: "bee",
      deliver: () => {},
      hasJoined: (url) => { seen.push(url); return false; },
      maxAttempts: 1,
      retryIntervalMs: 10,
      sleep: noSleep,
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([URL_A]));
  });
});
