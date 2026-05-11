/**
 * Integration tests for the apiary CLI — exercises the full server + client
 * stack using --headless mode and direct HTTP calls.
 *
 * Requires a built CLI at dist/cli/index.js. Run `npm run build` first.
 */

import { describe, test, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../dist/cli/index.js");
const NODE = process.execPath;

// Skip all tests if dist doesn't exist
const HAS_BUILD = existsSync(CLI_PATH);

// ── Test helpers ────────────────────────────────────────────────────────────

interface ServerHandle {
  process: ChildProcess;
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
  cleanup: () => void;
}

let nextPort = 18900 + Math.floor(Math.random() * 100);

function getPort(): number {
  return nextPort++;
}

async function startServer(opts?: { port?: number; room?: string; env?: Record<string, string> }): Promise<ServerHandle> {
  const port = opts?.port ?? getPort();
  const args = ["serve", "--headless", "--port", String(port)];
  if (opts?.room) args.push("--room", opts.room);

  const child = spawn(NODE, [CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts?.env ?? {}) },
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 10_000);
    let buffer = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

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
          cleanup: () => {
            child.kill("SIGTERM");
          },
        });
      } catch {
        clearTimeout(timer);
        reject(new Error(`Failed to parse server output: ${line}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

interface JoinResponse {
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Array<{ id: string; name: string; type: string; authority?: string }>;
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

async function httpSend(
  serverUrl: string,
  sessionToken: string,
  content: string,
): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch(`${serverUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content }),
  });
  return res.json() as Promise<{ ok: boolean; messageId?: string }>;
}

async function httpDisconnect(serverUrl: string, sessionToken: string): Promise<void> {
  await fetch(`${serverUrl}/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({}),
  }).catch(() => {});
}

async function httpParticipants(
  serverUrl: string,
  sessionToken: string,
): Promise<Array<{ id: string; name: string; type: string; authority?: string }>> {
  const res = await fetch(`${serverUrl}/participants`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) throw new Error(`Failed to get participants: ${await res.text()}`);
  const data = (await res.json()) as { participants: Array<{ id: string; name: string; type: string; authority?: string }> };
  return data.participants;
}

interface HeadlessClient {
  process: ChildProcess;
  events: Array<Record<string, unknown>>;
  send(message: string): void;
  waitForEvent(
    predicate: (e: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  cleanup: () => void;
}

function joinHeadless(
  serverUrl: string,
  token: string,
  opts?: { name?: string; guest?: boolean },
): Promise<HeadlessClient> {
  const url = `${serverUrl}?token=${token}`;
  const args = [CLI_PATH, "join", url, "--headless"];
  if (opts?.name) args.push("--name", opts.name);
  if (opts?.guest) args.push("--guest");

  const child = spawn(NODE, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (e: Record<string, unknown>) => boolean;
    resolve: (e: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];

  const rl = createInterface({ input: child.stdout!, terminal: false });
  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      // Check waiters
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(event)) {
          waiters[i].resolve(event);
          waiters.splice(i, 1);
        }
      }
    } catch {
      // not JSON
    }
  });

  // Wait a bit for connection to establish
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        process: child,
        events,
        send(message: string) {
          child.stdin!.write(message + "\n");
        },
        waitForEvent(predicate, timeoutMs = 5000) {
          // Check existing events first
          const existing = events.find(predicate);
          if (existing) return Promise.resolve(existing);

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error("waitForEvent timed out"));
            }, timeoutMs);

            waiters.push({
              predicate,
              resolve: (e) => { clearTimeout(timer); res(e); },
              reject: (err) => { clearTimeout(timer); rej(err); },
            });
          });
        },
        cleanup() {
          child.stdin!.end();
          child.kill("SIGTERM");
        },
      });
    }, 500);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_BUILD)("Integration", () => {
  const servers: ServerHandle[] = [];
  const clients: HeadlessClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.cleanup();
    for (const s of servers.splice(0)) s.cleanup();
    // Brief pause for OS to release ports
    await new Promise((r) => setTimeout(r, 100));
  });

  // ── 1. Server lifecycle ──────────────────────────────────────────────

  test("headless server starts and outputs JSON", async () => {
    const server = await startServer();
    servers.push(server);

    expect(server.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.roomName).toBeTruthy();
    expect(server.adminToken).toBeTruthy();
    expect(server.memberToken).toBeTruthy();

    // Verify server is reachable
    const res = await fetch(`${server.serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.memberToken, name: "probe", type: "human" }),
    });
    expect(res.ok).toBe(true);
  }, 15_000);

  // ── 2. Join/leave ─────────────────────────────────────────────────────

  test("participant joins and appears in list, then disconnects", async () => {
    const server = await startServer();
    servers.push(server);

    const join1 = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    expect(join1.authority).toBe("member");
    expect(join1.roomName).toBe(server.roomName);

    const list = await httpParticipants(server.serverUrl, join1.sessionToken);
    expect(list.find((p) => p.name === "Alice")).toBeTruthy();

    await httpDisconnect(server.serverUrl, join1.sessionToken);

    // Join again to check participant list
    const join2 = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    const list2 = await httpParticipants(server.serverUrl, join2.sessionToken);
    expect(list2.find((p) => p.name === "Alice")).toBeFalsy();
    expect(list2.find((p) => p.name === "Bob")).toBeTruthy();
  }, 15_000);

  // ── 3. Observer join ──────────────────────────────────────────────────

  test("guest joins with guest authority", async () => {
    const server = await startServer();
    servers.push(server);

    // Generate guest token
    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const shareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ authority: "guest" }),
    });
    const shareData = (await shareRes.json()) as { links: Record<string, string> };
    const guestUrl = shareData.links.guest;
    const guestToken = new URL(guestUrl).searchParams.get("token")!;

    const obs = await httpJoin(server.serverUrl, guestToken, { name: "Watcher" });
    expect(obs.authority).toBe("guest");
  }, 15_000);

  // ── 4. Messaging ──────────────────────────────────────────────────────

  test("messages sent via HTTP appear in search", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    await httpSend(server.serverUrl, alice.sessionToken, "hello world unique123");

    // Search for the message
    const searchRes = await fetch(
      `${server.serverUrl}/search?query=unique123`,
      { headers: { Authorization: `Bearer ${alice.sessionToken}` } },
    );
    const searchData = (await searchRes.json()) as { items: Array<{ content: string }> };
    expect(searchData.items.length).toBeGreaterThanOrEqual(1);
    expect(searchData.items.some((m) => m.content.includes("unique123"))).toBe(true);
  }, 15_000);

  test("headless client receives messages via SSE", async () => {
    const server = await startServer();
    servers.push(server);

    const client = await joinHeadless(server.serverUrl, server.memberToken, { name: "Eve" });
    clients.push(client);

    // Send a message from another participant
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    await httpSend(server.serverUrl, bob.sessionToken, "ping from bob");

    const event = await client.waitForEvent(
      (e) => e.type === "MessageSent" && (e as any).message?.content === "ping from bob",
    );
    expect(event).toBeTruthy();
  }, 15_000);

  // ── 5. Authority enforcement ──────────────────────────────────────────

  test("guest cannot send messages", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const shareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ authority: "guest" }),
    });
    const shareData = (await shareRes.json()) as { links: Record<string, string> };
    const guestToken = new URL(shareData.links.guest).searchParams.get("token")!;

    const obs = await httpJoin(server.serverUrl, guestToken);
    expect(obs.authority).toBe("guest");

    const sendRes = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${obs.sessionToken}` },
      body: JSON.stringify({ content: "should fail" }),
    });
    expect(sendRes.status).toBe(403);
  }, 15_000);

  // ── 6. Non-admin can't kick ───────────────────────────────────────────

  test("participant cannot kick others", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });

    const kickRes = await fetch(`${server.serverUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({ participantId: bob.participantId }),
    });
    expect(kickRes.status).toBe(403);
  }, 15_000);

  // ── 7. Admin can kick ─────────────────────────────────────────────────

  test("admin can kick a participant", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });

    const kickRes = await fetch(`${server.serverUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ participantId: target.participantId }),
    });
    expect(kickRes.ok).toBe(true);

    const list = await httpParticipants(server.serverUrl, admin.sessionToken);
    expect(list.find((p) => p.name === "Target")).toBeFalsy();
  }, 15_000);

  // ── 8. Mute/unmute (authority change) ─────────────────────────────────

  test("admin can mute (demote to guest) and unmute (restore to member)", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    // Verify Alice can send before mute
    const send1 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({ content: "before mute" }),
    });
    expect(send1.ok).toBe(true);

    // Mute Alice (demote to guest)
    const muteRes = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({
        participantId: alice.participantId,
        authority: "guest",
      }),
    });
    expect(muteRes.ok).toBe(true);

    // Alice should now be blocked from sending
    const send2 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({ content: "should fail" }),
    });
    expect(send2.status).toBe(403);

    // Unmute Alice (restore to member)
    const unmuteRes = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({
        participantId: alice.participantId,
        authority: "member",
      }),
    });
    expect(unmuteRes.ok).toBe(true);

    // Alice should be able to send again
    const send3 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({ content: "after unmute" }),
    });
    expect(send3.ok).toBe(true);
  }, 15_000);

  // ── 9. Multi-participant ──────────────────────────────────────────────

  test("multiple participants see each other", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    const charlie = await httpJoin(server.serverUrl, server.memberToken, { name: "Charlie" });

    const list = await httpParticipants(server.serverUrl, alice.sessionToken);
    const names = list.map((p) => p.name);
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");
    expect(names).toContain("Charlie");
  }, 15_000);

  // ── 10. Share link generation ──────────────────────────────────────────

  test("admin gets all tier links, participant gets limited links", async () => {
    const server = await startServer();
    servers.push(server);

    // Admin gets all tiers
    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const adminShareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({}),
    });
    const adminLinks = ((await adminShareRes.json()) as { links: Record<string, string> }).links;
    expect(adminLinks.admin).toBeTruthy();
    expect(adminLinks.member).toBeTruthy();
    expect(adminLinks.guest).toBeTruthy();

    // Member only gets member + guest
    const part = await httpJoin(server.serverUrl, server.memberToken, { name: "Part" });
    const partShareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${part.sessionToken}` },
      body: JSON.stringify({}),
    });
    const partLinks = ((await partShareRes.json()) as { links: Record<string, string> }).links;
    expect(partLinks.admin).toBeUndefined();
    expect(partLinks.member).toBeTruthy();
    expect(partLinks.guest).toBeTruthy();
  }, 15_000);

  // ── 11. @mention delivery ─────────────────────────────────────────────

  test("@mention delivers MentionedEvent to target SSE stream", async () => {
    const server = await startServer();
    servers.push(server);

    // Alice joins via headless to receive SSE events
    const alice = await joinHeadless(server.serverUrl, server.memberToken, { name: "Alice" });
    clients.push(alice);

    // Bob joins via HTTP and sends @Alice
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    await httpSend(server.serverUrl, bob.sessionToken, "hey @Alice what do you think?");

    // Alice should receive the MessageSent event
    const msgEvent = await alice.waitForEvent(
      (e) => e.type === "MessageSent" && (e as any).message?.content?.includes("@Alice"),
    );
    expect(msgEvent).toBeTruthy();
  }, 15_000);

  // ── 12. Self-demotion blocked ──────────────────────────────────────────

  test("admin cannot demote self", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });

    const res = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({
        participantId: admin.participantId,
        authority: "guest",
      }),
    });
    expect(res.status).toBe(400);
  }, 15_000);

  // ── 13. Non-admin cannot change authority ──────────────────────────────

  test("non-admin cannot change authority", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });

    const res = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({
        participantId: bob.participantId,
        authority: "guest",
      }),
    });
    expect(res.status).toBe(403);
  }, 15_000);

  // ── 14. /tunnel — non-admin rejected ──────────────────────────────────

  test("/tunnel rejects non-admin", async () => {
    const server = await startServer();
    servers.push(server);

    const member = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    const res = await fetch(`${server.serverUrl}/tunnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.sessionToken}` },
    });
    expect(res.status).toBe(403);
  }, 15_000);

  // ── 15. /tunnel — requires cloudflared ────────────────────────────────

  test("/tunnel returns error when cloudflared is not available", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });

    // With no cloudflared on PATH (CI), startTunnel returns null → 500
    const res = await fetch(`${server.serverUrl}/tunnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
    });
    // Either 500 (no cloudflared) or 200 (cloudflared present) — both are valid
    expect([200, 500]).toContain(res.status);

    if (res.status === 200) {
      const data = (await res.json()) as { url: string; alreadyRunning: boolean };
      expect(data.url).toBeTruthy();
      expect(typeof data.alreadyRunning).toBe("boolean");

      // Second call should say already running
      const res2 = await fetch(`${server.serverUrl}/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as { url: string; alreadyRunning: boolean };
      expect(data2.alreadyRunning).toBe(true);
      expect(data2.url).toBe(data.url);
    } else {
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/cloudflared/i);
    }
  }, 30_000);

  // ── 16. Agent busy/idle detection from /messages ──────────────────────

  test("agent busy/idle: no messages → no state to infer", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    await httpJoin(server.serverUrl, server.memberToken, { name: "Bot", type: "agent" });

    // No messages sent — /messages returns empty
    const res = await fetch(`${server.serverUrl}/messages?count=20`, {
      headers: { Authorization: `Bearer ${admin.sessionToken}` },
    });
    const { items: messages } = (await res.json()) as { items: unknown[] };
    expect(messages).toHaveLength(0);
  }, 15_000);

  test("agent busy/idle: human spoke, agent replied → agent idle", async () => {
    const server = await startServer();
    servers.push(server);

    const human = await httpJoin(server.serverUrl, server.adminToken, { name: "Human" });
    const bot = await httpJoin(server.serverUrl, server.memberToken, { name: "Bot", type: "agent" });

    // Human speaks, then bot replies
    await httpSend(server.serverUrl, human.sessionToken, "hello bot");
    await httpSend(server.serverUrl, bot.sessionToken, "hello human");

    const res = await fetch(`${server.serverUrl}/messages?count=20`, {
      headers: { Authorization: `Bearer ${human.sessionToken}` },
    });
    const { items: messages } = (await res.json()) as {
      items: Array<{ sender_id: string; sender_name: string }>;
    };

    // Newest first — bot spoke last
    expect(messages[0].sender_name).toBe("Bot");
    expect(messages[1].sender_name).toBe("Human");

    // Walk logic: Bot → idle, hit Human → break. Bot replied → idle.
    const idleAgents = new Set<string>();
    let foundHuman = false;
    for (const msg of messages) {
      const isAgent = msg.sender_id === bot.participantId;
      const isHuman = msg.sender_id === human.participantId;
      if (isAgent) idleAgents.add(msg.sender_name);
      else if (isHuman) { foundHuman = true; break; }
    }
    expect(foundHuman).toBe(true);
    expect(idleAgents.has("Bot")).toBe(true);
  }, 15_000);

  test("agent busy/idle: human spoke, agent did not reply → agent busy", async () => {
    const server = await startServer();
    servers.push(server);

    const human = await httpJoin(server.serverUrl, server.adminToken, { name: "Human" });
    await httpJoin(server.serverUrl, server.memberToken, { name: "Bot", type: "agent" });

    // Human speaks, bot does NOT reply
    await httpSend(server.serverUrl, human.sessionToken, "hello bot");

    const res = await fetch(`${server.serverUrl}/messages?count=20`, {
      headers: { Authorization: `Bearer ${human.sessionToken}` },
    });
    const { items: messages } = (await res.json()) as {
      items: Array<{ sender_id: string; sender_name: string }>;
    };

    // Newest first — only human message
    expect(messages[0].sender_name).toBe("Human");

    // Walk logic: hit Human immediately → break, no agents in idleAgents
    const idleAgents = new Set<string>();
    let foundHuman = false;
    for (const msg of messages) {
      const isAgent = msg.sender_id !== human.participantId;
      if (isAgent) idleAgents.add(msg.sender_name);
      else { foundHuman = true; break; }
    }
    expect(foundHuman).toBe(true);
    expect(idleAgents.has("Bot")).toBe(false);
  }, 15_000);

  // ── 20. Presence tracking ────────────────────────────────────────────────

  function collectPresenceEvents(
    serverUrl: string,
    sessionToken: string,
    signal: AbortSignal,
  ): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    fetch(`${serverUrl}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal,
    }).then(async (res) => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (ev.type === "StatusChanged") events.push(ev);
            } catch { /* skip non-JSON */ }
          }
        }
      }
    }).catch(() => {});
    return events;
  }

  test("presence: participant marked unresponsive then offline on inactivity", async () => {
    // Very short thresholds: unresponsive at 200ms, offline at 400ms, check every 100ms
    const server = await startServer({ env: { APIARY_UNRESPONSIVE_MS: "200", APIARY_PRESENCE_CHECK_MS: "100" } });
    servers.push(server);

    const observer = await httpJoin(server.serverUrl, server.adminToken, { name: "Observer" });
    const obsController = new AbortController();
    const presenceEvents = collectPresenceEvents(server.serverUrl, observer.sessionToken, obsController.signal);
    await new Promise((r) => setTimeout(r, 100)); // let SSE establish

    // Target joins HTTP only — no SSE, no further HTTP calls → will time out
    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });

    // Wait for unresponsive (200ms threshold + 100ms check + buffer)
    await new Promise((r) => setTimeout(r, 600));

    const unresponsive = presenceEvents.find(
      (e) => e.participant_id === target.participantId && e.status === "unresponsive",
    );
    expect(unresponsive).toBeDefined();
    expect(unresponsive?.previous_status).toBe("online");
    expect(unresponsive?.reason).toBe("ping_timeout");
    expect(unresponsive?.name).toBe("Target");

    // Wait for offline (OFFLINE_AFTER_MS = 400ms from last seen; ~400ms after join)
    await new Promise((r) => setTimeout(r, 500));

    const offline = presenceEvents.find(
      (e) => e.participant_id === target.participantId && e.status === "offline",
    );
    expect(offline).toBeDefined();
    expect(offline?.previous_status).toBe("unresponsive");
    expect(offline?.reason).toBe("ping_timeout");

    obsController.abort();
  }, 15_000);

  test("presence: unresponsive or offline participant recovers on SSE reconnect", async () => {
    // Use a very high OFFLINE threshold so the participant stays unresponsive
    // long enough for us to reconnect and observe the recovery event.
    const server = await startServer({ env: { APIARY_UNRESPONSIVE_MS: "200", APIARY_PRESENCE_CHECK_MS: "100" } });
    servers.push(server);

    const observer = await httpJoin(server.serverUrl, server.adminToken, { name: "Observer" });
    const obsController = new AbortController();
    const presenceEvents = collectPresenceEvents(server.serverUrl, observer.sessionToken, obsController.signal);
    await new Promise((r) => setTimeout(r, 100));

    // Target joins HTTP only → will go unresponsive then offline
    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });

    // Wait long enough for at least one timeout transition (unresponsive or offline)
    await new Promise((r) => setTimeout(r, 700));
    expect(presenceEvents.find(
      (e) => e.participant_id === target.participantId &&
             (e.status === "unresponsive" || e.status === "offline"),
    )).toBeDefined();

    // Target reconnects SSE → recovery event regardless of whether unresponsive or offline
    const targetController = new AbortController();
    collectPresenceEvents(server.serverUrl, target.sessionToken, targetController.signal);
    await new Promise((r) => setTimeout(r, 300));

    const recovery = presenceEvents.find(
      (e) => e.participant_id === target.participantId && e.status === "online" && e.reason === "recovered",
    );
    expect(recovery).toBeDefined();
    expect(["unresponsive", "offline"]).toContain(recovery?.previous_status);

    targetController.abort();
    obsController.abort();
  }, 15_000);

  test("presence: disconnect emits offline StatusChangedEvent", async () => {
    const server = await startServer();
    servers.push(server);

    const observer = await httpJoin(server.serverUrl, server.adminToken, { name: "Observer" });
    const obsController = new AbortController();
    const presenceEvents = collectPresenceEvents(server.serverUrl, observer.sessionToken, obsController.signal);
    await new Promise((r) => setTimeout(r, 100));

    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });
    await httpDisconnect(server.serverUrl, target.sessionToken);

    await new Promise((r) => setTimeout(r, 200));

    const offline = presenceEvents.find(
      (e) => e.participant_id === target.participantId && e.status === "offline" && e.reason === "left",
    );
    expect(offline).toBeDefined();
    expect(offline?.previous_status).toBe("online");
    expect(offline?.name).toBe("Target");

    obsController.abort();
  }, 15_000);

  test("presence: kick emits offline StatusChangedEvent", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const obsController = new AbortController();
    const presenceEvents = collectPresenceEvents(server.serverUrl, admin.sessionToken, obsController.signal);
    await new Promise((r) => setTimeout(r, 100));

    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });

    await fetch(`${server.serverUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ participantId: target.participantId }),
    });

    await new Promise((r) => setTimeout(r, 200));

    const offline = presenceEvents.find(
      (e) => e.participant_id === target.participantId && e.status === "offline" && e.reason === "kicked",
    );
    expect(offline).toBeDefined();
    expect(offline?.previous_status).toBe("online");

    obsController.abort();
  }, 15_000);

  test("agent busy/idle: two agents, one replied one did not", async () => {
    const server = await startServer();
    servers.push(server);

    const human = await httpJoin(server.serverUrl, server.adminToken, { name: "Human" });
    const botA = await httpJoin(server.serverUrl, server.memberToken, { name: "BotA", type: "agent" });
    await httpJoin(server.serverUrl, server.memberToken, { name: "BotB", type: "agent" });

    // Human speaks, only BotA replies
    await httpSend(server.serverUrl, human.sessionToken, "hello bots");
    await httpSend(server.serverUrl, botA.sessionToken, "hello from A");

    const res = await fetch(`${server.serverUrl}/messages?count=20`, {
      headers: { Authorization: `Bearer ${human.sessionToken}` },
    });
    const { items: messages } = (await res.json()) as {
      items: Array<{ sender_id: string; sender_name: string }>;
    };

    // Walk: BotA → idle, Human → break. BotB not seen → busy.
    const idleAgents = new Set<string>();
    let foundHuman = false;
    for (const msg of messages) {
      if (msg.sender_id === human.participantId) { foundHuman = true; break; }
      idleAgents.add(msg.sender_name);
    }
    expect(foundHuman).toBe(true);
    expect(idleAgents.has("BotA")).toBe(true);
    expect(idleAgents.has("BotB")).toBe(false);
  }, 15_000);

  // ── Attachment endpoints ──────────────────────────────────────────────

  test("POST /attachment stores file, GET /attachment/:id returns bytes", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const content = Buffer.from("hello attachment");

    const uploadRes = await fetch(`${server.serverUrl}/attachment`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": "attachment; filename=hello.txt",
        Authorization: `Bearer ${alice.sessionToken}`,
      },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    const uploadData = (await uploadRes.json()) as { id: string; name: string; mime_type: string; size: number };
    expect(uploadData.name).toBe("hello.txt");
    expect(uploadData.mime_type).toBe("text/plain");
    expect(uploadData.size).toBe(content.length);

    const getRes = await fetch(`${server.serverUrl}/attachment/${uploadData.id}`, {
      headers: { Authorization: `Bearer ${alice.sessionToken}` },
    });
    expect(getRes.status).toBe(200);
    const bytes = Buffer.from(await getRes.arrayBuffer());
    expect(bytes.equals(content)).toBe(true);
  }, 15_000);

  test("POST /attachment with oversized body returns 413", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    // 11 MB > 10 MB server cap
    const bigBody = Buffer.alloc(11 * 1024 * 1024, "x");

    const res = await fetch(`${server.serverUrl}/attachment`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${alice.sessionToken}` },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  }, 15_000);

  test("send_message with upload attachment broadcasts metadata, GET returns bytes", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });

    // Upload attachment
    const content = Buffer.from("file contents");
    const uploadRes = await fetch(`${server.serverUrl}/attachment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=data.bin",
        Authorization: `Bearer ${alice.sessionToken}`,
      },
      body: content,
    });
    const uploadData = (await uploadRes.json()) as { id: string; url: string; name: string; mime_type: string; size: number };

    // Connect Bob as SSE observer
    const bobClient = await joinHeadless(server.serverUrl, server.memberToken, { name: "BobObs" });
    clients.push(bobClient);

    // Send message referencing the attachment
    const sendRes = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({
        content: "here is a file",
        attachments: [{ type: "upload", id: uploadData.id, name: uploadData.name, mime_type: uploadData.mime_type, size: uploadData.size, url: uploadData.url }],
      }),
    });
    expect(sendRes.status).toBe(200);

    // Verify SSE broadcast contains the attachment metadata
    const msgEvent = await bobClient.waitForEvent(
      (e) => e.type === "MessageSent" && (e as any).message?.content === "here is a file",
    );
    const attachments = (msgEvent as any).message?.attachments ?? [];
    expect(attachments.length).toBe(1);
    expect(attachments[0].type).toBe("upload");
    expect(attachments[0].id).toBe(uploadData.id);

    // Fetch bytes back
    const getRes = await fetch(`${server.serverUrl}/attachment/${uploadData.id}`, {
      headers: { Authorization: `Bearer ${alice.sessionToken}` },
    });
    expect(getRes.status).toBe(200);
    const bytes = Buffer.from(await getRes.arrayBuffer());
    expect(bytes.equals(content)).toBe(true);

  }, 15_000);

  test("POST /message rejects malformed attachment", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    const res = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.sessionToken}` },
      body: JSON.stringify({
        content: "test",
        attachments: [{ type: "unknown", id: "abc" }],
      }),
    });
    expect(res.status).toBe(400);
  }, 15_000);

  test("guest cannot upload attachments", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const shareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.sessionToken}` },
      body: JSON.stringify({ authority: "guest" }),
    });
    const shareData = (await shareRes.json()) as { links: Record<string, string> };
    const guestToken = new URL(shareData.links.guest).searchParams.get("token")!;
    const guest = await httpJoin(server.serverUrl, guestToken, { name: "Guest" });

    const res = await fetch(`${server.serverUrl}/attachment`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${guest.sessionToken}` },
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(403);
  }, 15_000);
});
