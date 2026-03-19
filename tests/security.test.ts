/**
 * Security tests for apiary — exercises hardening features.
 *
 * Requires a built CLI at dist/cli/index.js. Run `npm run build` first.
 */

import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TokenManager } from "../src/cli/auth.js";

const CLI_PATH = resolve(__dirname, "../dist/cli/index.js");
const NODE = process.execPath;

const HAS_BUILD = existsSync(CLI_PATH);

// ── Test helpers (duplicated from integration for isolation) ─────────────

interface ServerHandle {
  process: ChildProcess;
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
  cleanup: () => void;
}

let nextPort = 19900 + Math.floor(Math.random() * 100);

function getPort(): number {
  return nextPort++;
}

async function startServer(opts?: { port?: number; extraArgs?: string[] }): Promise<ServerHandle> {
  const port = opts?.port ?? getPort();
  const args = ["serve", "--headless", "--port", String(port), ...(opts?.extraArgs ?? [])];

  const child = spawn(NODE, [CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 10_000);
    let buffer = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);

      try {
        const data = JSON.parse(line);
        clearTimeout(timer);
        resolve({
          process: child,
          serverUrl: data.serverUrl,
          publicUrl: data.publicUrl,
          roomName: data.roomName,
          adminToken: data.adminToken,
          memberToken: data.memberToken,
          cleanup: () => { child.kill("SIGTERM"); },
        });
      } catch {
        clearTimeout(timer);
        reject(new Error(`Failed to parse server output: ${line}`));
      }
    });

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
  });
}

interface JoinResponse {
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
}

async function httpJoin(
  serverUrl: string,
  token: string,
  opts?: { name?: string; type?: string },
): Promise<JoinResponse> {
  const body: Record<string, unknown> = { token };
  if (opts?.name) body.name = opts.name;
  if (opts?.type) body.type = opts.type;

  const res = await fetch(`${serverUrl}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Join failed: ${await res.text()}`);
  return res.json() as Promise<JoinResponse>;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_BUILD)("Security", () => {
  const servers: ServerHandle[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.cleanup();
    await new Promise((r) => setTimeout(r, 100));
  });

  // ── Token expiry ───────────────────────────────────────────────────────

  test("TokenManager: expired session token is rejected", () => {
    const tm = new TokenManager({ sessionTtlMs: 1, shareTtlMs: 1 });
    const token = tm.createSessionToken("p1", "member");
    // Token has 1ms TTL — wait a bit
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(tm.validateSessionToken(token)).toBeNull();
  });

  test("TokenManager: expired share token is rejected", () => {
    const tm = new TokenManager({ sessionTtlMs: 60_000, shareTtlMs: 1 });
    const token = tm.generateShareToken("admin", "member")!;
    expect(token).toBeTruthy();
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(tm.validateShareToken(token)).toBeNull();
  });

  // ── Token rotation ────────────────────────────────────────────────────

  test("TokenManager: rotated token works, old token rejected", () => {
    const tm = new TokenManager();
    const oldToken = tm.createSessionToken("p1", "member");
    expect(tm.validateSessionToken(oldToken)).toBeTruthy();

    const result = tm.rotateSessionToken(oldToken);
    expect(result).toBeTruthy();
    expect(result!.newToken).not.toBe(oldToken);

    // Old token should be gone
    expect(tm.validateSessionToken(oldToken)).toBeNull();
    // New token should work
    expect(tm.validateSessionToken(result!.newToken)).toBeTruthy();
    expect(tm.validateSessionToken(result!.newToken)!.participantId).toBe("p1");
  });

  // ── Token pruning ─────────────────────────────────────────────────────

  test("TokenManager: pruneExpired removes expired tokens", () => {
    const tm = new TokenManager({ sessionTtlMs: 1, shareTtlMs: 1 });
    tm.createSessionToken("p1", "member");
    tm.generateShareToken("admin", "member");
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    tm.pruneExpired();
    // After pruning, findSessionByParticipant should return null
    expect(tm.findSessionByParticipant("p1")).toBeNull();
  });

  // ── Integer bounds ────────────────────────────────────────────────────

  test("count parameter is clamped to max", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    // count=999999 should be clamped, not error
    const res = await fetch(
      `${server.serverUrl}/messages?count=999999`,
      { headers: { Authorization: `Bearer ${alice.sessionToken}` } },
    );
    expect(res.ok).toBe(true);
  }, 15_000);

  // ── Message length ────────────────────────────────────────────────────

  test("message >50k chars is rejected", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const longContent = "x".repeat(50_001);

    const res = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({ content: longContent }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("too long");
  }, 15_000);

  // ── Rate limiting ─────────────────────────────────────────────────────

  test("burst of join requests returns 429", async () => {
    const server = await startServer();
    servers.push(server);

    // 10 joins should be fine (limit is 10/min), 11th should fail
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${server.serverUrl}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: server.memberToken, name: `User${i}`, type: "human" }),
      });
      results.push(res.status);
    }

    expect(results.filter((s) => s === 200).length).toBe(10);
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  // ── Backward compat: query param auth still works ─────────────────────

  test("legacy ?token= query param still works for GET", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    // Legacy style: token in query param
    const res = await fetch(`${server.serverUrl}/participants?token=${alice.sessionToken}`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { participants: unknown[] };
    expect(data.participants.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  // ── Token rotation via HTTP endpoint ───────────────────────────────────

  test("POST /rotate-token returns new token, old token rejected", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const oldToken = alice.sessionToken;

    // Rotate
    const rotateRes = await fetch(`${server.serverUrl}/rotate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({}),
    });
    expect(rotateRes.ok).toBe(true);
    const rotateData = (await rotateRes.json()) as { sessionToken: string };
    expect(rotateData.sessionToken).toBeTruthy();
    expect(rotateData.sessionToken).not.toBe(oldToken);

    // New token works
    const listRes = await fetch(`${server.serverUrl}/participants`, {
      headers: { Authorization: `Bearer ${rotateData.sessionToken}` },
    });
    expect(listRes.ok).toBe(true);

    // Old token rejected
    const oldRes = await fetch(`${server.serverUrl}/participants`, {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldRes.status).toBe(401);
  }, 15_000);

  // ── Bind address ───────────────────────────────────────────────────────

  test("server binds to 127.0.0.1 by default", async () => {
    const server = await startServer();
    servers.push(server);

    // serverUrl should be 127.0.0.1
    expect(server.serverUrl).toContain("127.0.0.1");
  }, 15_000);
});
