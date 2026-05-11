/**
 * apiary room create / resume / list
 *
 * Interactive room management — the human-friendly entry point.
 * Daemon pattern: server spawns as a detached child process so the TUI
 * can exit (Ctrl+C) without killing the room.
 */

import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { createInterface } from "node:readline";

import { buildShareUrl } from "./auth.js";
import {
  listRoomSessions, saveRoomSession, removeRoomSession, INVITES_DIR,
  type PersistedRoomSession,
} from "./serve.js";
import {
  tmuxAvailable, tmuxSessionExists, tmuxKillSession,
} from "./tmux.js";

/** 7 days in ms — default share token TTL for persistent daemon sessions. */
const DAEMON_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Readline prompt helper ────────────────────────────────────────────────────

interface Prompter {
  ask: (q: string) => Promise<string>;
  close: () => void;
}

function makePrompt(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q: string) => new Promise((res) => rl.question(q, (a) => res(a.trim()))),
    close: () => rl.close(),
  };
}

// ── Daemon server spawn ───────────────────────────────────────────────────────

interface DaemonResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
  savePath: string;
  pid: number;
}

export async function spawnDaemonServer(opts: {
  room?: string;
  port?: number;
  share?: boolean;
  expose?: boolean;
  shareTtlMs?: number;
}): Promise<DaemonResult | null> {
  const scriptPath = process.argv[1];
  const ttl = opts.shareTtlMs ?? DAEMON_SHARE_TTL_MS;

  const args = ["serve", "--headless", "--share-token-ttl", String(ttl)];
  if (opts.room) args.push("--room", opts.room);
  if (opts.port) args.push("--port", String(opts.port));
  if (opts.share) args.push("--share");
  if (opts.expose) args.push("--expose");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        try {
          const result = JSON.parse(line.trim());
          child.unref();
          resolve({ ...result, pid: child.pid! });
        } catch {
          // keep buffering
        }
      }
    });

    child.on("error", () => resolve(null));
    child.on("exit", (code) => { if (code !== 0) resolve(null); });
    setTimeout(() => resolve(null), 15_000);
  });
}

// ── Invite file helpers ───────────────────────────────────────────────────────

export function writeInvite(alias: string, joinUrl: string): void {
  mkdirSync(INVITES_DIR, { recursive: true });
  writeFileSync(pathJoin(INVITES_DIR, alias), joinUrl, { mode: 0o600 });
}

export function readAndConsumeInvite(alias: string): string | null {
  const p = pathJoin(INVITES_DIR, alias);
  if (!existsSync(p)) return null;
  try {
    const url = readFileSync(p, "utf-8").trim();
    unlinkSync(p);
    return url;
  } catch {
    return null;
  }
}

function isLocalPath(p: string): boolean {
  try {
    return existsSync(p.replace(/^~/, homedir()));
  } catch {
    return false;
  }
}

// ── Lightweight HTTP helpers (no TUI) ─────────────────────────────────────────

/** Join a room as a transient agent and return the session token. */
async function httpJoin(
  serverUrl: string,
  shareToken: string,
  name = "[system]",
): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareToken, name, type: "agent" }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { sessionToken?: string };
    return data.sessionToken ?? null;
  } catch {
    return null;
  }
}

/** Disconnect a participant by session token. */
async function httpDisconnect(serverUrl: string, sessionToken: string): Promise<void> {
  await fetch(`${serverUrl}/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
  }).catch(() => {});
}

/**
 * Post a system message to the room as a transient participant.
 * Joins with the admin share token, posts, then immediately disconnects.
 */
async function postSystemMessage(
  serverUrl: string,
  adminShareToken: string,
  content: string,
): Promise<void> {
  const sessionToken = await httpJoin(serverUrl, adminShareToken, "[system]");
  if (!sessionToken) return;
  await fetch(`${serverUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content }),
  }).catch(() => {});
  await httpDisconnect(serverUrl, sessionToken);
}

/**
 * Open a single transient admin session and fetch both fresh share tokens
 * and the currently connected participant names.
 *
 * GET /participants and POST /share both require a session token (not a share
 * token), so we join once, make both calls, then immediately disconnect.
 */
async function fetchServerState(
  serverUrl: string,
  adminShareToken: string,
  publicUrl: string,
): Promise<{ memberToken?: string; connectedNames: Set<string> }> {
  const sessionToken = await httpJoin(serverUrl, adminShareToken, "[system]");
  if (!sessionToken) return { connectedNames: new Set() };

  let memberToken: string | undefined;
  let connectedNames: Set<string> = new Set();

  try {
    const [shareRes, participantsRes] = await Promise.all([
      fetch(`${serverUrl}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({}),
      }),
      fetch(`${serverUrl}/participants`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      }),
    ]);

    if (shareRes.ok) {
      const data = await shareRes.json() as { links?: Record<string, string> };
      const memberUrl = data.links?.["member"];
      if (memberUrl) memberToken = extractToken(memberUrl) ?? undefined;
    }

    if (participantsRes.ok) {
      const data = await participantsRes.json() as { participants: Array<{ name: string }> };
      connectedNames = new Set(data.participants.map((p) => p.name.toLowerCase()));
    }
  } finally {
    await httpDisconnect(serverUrl, sessionToken);
  }

  return { memberToken, connectedNames };
}

// ── Agent background spawn ────────────────────────────────────────────────────

/**
 * Spawn `apiary <runtime> <alias> --background` as a detached child process in
 * the participant's cwd. The child creates its own tmux session and runs until
 * SIGTERM (sent by `roomStop`).
 *
 * Returns true on success, false if the cwd doesn't exist or spawn fails.
 */
function spawnAgentBackground(alias: string, cwd: string, runtime: string): boolean {
  const resolvedCwd = cwd.replace(/^~/, homedir());
  if (!existsSync(resolvedCwd)) return false;
  try {
    const child = spawn(process.execPath, [process.argv[1], runtime, alias, "--background"], {
      detached: true,
      stdio: "ignore",
      cwd: resolvedCwd,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ── Print invite for one participant ─────────────────────────────────────────

function printInvite(alias: string, joinUrl: string, sameHost: boolean): void {
  const C = "\x1b[36m";
  const D = "\x1b[2m";
  const G = "\x1b[32m";
  const R = "\x1b[0m";

  if (sameHost) {
    writeInvite(alias, joinUrl);
    console.log(`  ${G}✓${R} ${alias}  ${D}(invite queued — auto-consumed on next launch)${R}`);
  } else {
    console.log(`  ${alias}:`);
  }
  console.log(`    ${C}apiary join${R} "${joinUrl}"`);
}

// ── apiary room create ────────────────────────────────────────────────────────

export async function roomCreate(opts: {
  room?: string;
  port?: number;
  share?: boolean;
  expose?: boolean;
}): Promise<void> {
  const Y = "\x1b[33m";
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const C = "\x1b[36m";
  const R = "\x1b[0m";

  const { ask, close } = makePrompt();

  console.log(`\n  ${Y}${B}apiary${R} — create room\n`);

  const roomName = opts.room ?? ((await ask(`  Room name ${D}[random]${R}: `)) || undefined);

  const ttlInput = await ask(`  Session duration ${D}[7d]${R}: `);
  const shareTtlMs = parseDuration(ttlInput) ?? DAEMON_SHARE_TTL_MS;

  const participants: Array<{ alias: string; cwd: string; role: string; runtime?: string }> = [];
  console.log(`\n  Invite participants ${D}(leave alias blank to finish)${R}:`);
  while (true) {
    const alias = await ask(`  → Alias: `);
    if (!alias) break;
    const cwd = (await ask(`    Repo path ${D}[${process.cwd()}]${R}: `)) || process.cwd();
    const role = (await ask(`    Role ${D}[agent]${R}: `)) || "agent";
    const runtimeInput = (await ask(`    Runtime ${D}[claude]${R} ${D}(claude/codex)${R}: `)) || "claude";
    const runtime = ["claude", "codex"].includes(runtimeInput) ? runtimeInput : "claude";
    participants.push({ alias, cwd, role, runtime });
  }

  close();

  console.log(`\n  Starting server in background...`);

  const daemon = await spawnDaemonServer({
    room: roomName,
    port: opts.port,
    share: opts.share,
    expose: opts.expose,
    shareTtlMs,
  });
  if (!daemon) {
    console.error("  Failed to start server.");
    process.exit(1);
  }

  saveRoomSession({
    roomName: daemon.roomName,
    serverUrl: daemon.serverUrl,
    publicUrl: daemon.publicUrl,
    adminToken: daemon.adminToken,
    memberToken: daemon.memberToken,
    pid: daemon.pid,
    lastActive: Date.now(),
    participants,
  });

  const shareBase = daemon.publicUrl !== daemon.serverUrl ? daemon.publicUrl : daemon.serverUrl;
  const memberJoinUrl = buildShareUrl(shareBase, daemon.memberToken);

  const canSpawn = tmuxAvailable();
  if (participants.length > 0) {
    console.log(`\n  ${B}Invite links:${R}\n`);
    const hasRuntimeParticipants = participants.some((p) => p.runtime);
    if (!canSpawn && hasRuntimeParticipants) {
      console.log(`  ${D}(tmux not found — agents will need to join manually via the invite links below)${R}\n`);
    }
    const allLocal = participants.every((p) => isLocalPath(p.cwd));
    for (const p of participants) {
      const sameHost = allLocal || isLocalPath(p.cwd);
      printInvite(p.alias, memberJoinUrl, sameHost);
      if (sameHost && canSpawn && p.runtime) {
        const ok = spawnAgentBackground(p.alias, p.cwd, p.runtime);
        if (ok) {
          console.log(`    ${D}→ spawned ${p.runtime} session (tmux attach -t apiary_${p.alias})${R}`);
        }
      }
    }
    console.log("");
  } else {
    console.log(`\n  ${D}Member join link:${R}  ${C}${memberJoinUrl}${R}\n`);
  }

  console.log(`  Press Ctrl+C to leave — server keeps running.\n`);

  const { join } = await import("./join.js");
  const adminJoinUrl = buildShareUrl(daemon.serverUrl, daemon.adminToken);
  await join({ server: adminJoinUrl });

  console.log(`\n  Server still running (room: ${Y}${daemon.roomName}${R})`);
  console.log(`  Rejoin: ${C}apiary room resume ${daemon.roomName}${R}\n`);
}

// ── apiary room resume ────────────────────────────────────────────────────────

export async function roomResume(name: string): Promise<void> {
  const Y = "\x1b[33m";
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const C = "\x1b[36m";
  const G = "\x1b[32m";
  const W = "\x1b[33m";
  const R = "\x1b[0m";

  const sessions = listRoomSessions();
  const session = sessions.find((s) => s.roomName === name);

  if (!session) {
    console.error(`  No saved session for room "${name}".`);
    console.error(`  Run: ${C}apiary room list${R}  to see saved rooms.`);
    process.exit(1);
  }

  let serverUrl = session.serverUrl;
  let adminToken = session.adminToken;
  let memberToken = session.memberToken;
  let publicUrl = session.publicUrl;
  let pid = session.pid;

  const alive = isServerAlive(session);

  let connectedNames: Set<string> = new Set();

  if (alive) {
    console.log(`\n  ${Y}${B}${name}${R}  ${D}server running (PID ${pid})${R}\n`);

    // One transient admin session to refresh share tokens + fetch connected participants.
    // GET /participants and POST /share both require a session token, so we join once,
    // call both in parallel, then immediately disconnect. Falls back to stored memberToken
    // if the refresh fails (e.g. stored adminToken already expired — restart the room).
    const state = await fetchServerState(serverUrl, adminToken, publicUrl);
    if (state.memberToken) memberToken = state.memberToken;
    connectedNames = state.connectedNames;
  } else {
    console.log(`\n  ${Y}${B}${name}${R}  ${D}server stopped — restarting...${R}\n`);

    const daemon = await spawnDaemonServer({ room: name });
    if (!daemon) {
      console.error("  Failed to restart server.");
      process.exit(1);
    }

    serverUrl = daemon.serverUrl;
    adminToken = daemon.adminToken;
    memberToken = daemon.memberToken;
    publicUrl = daemon.publicUrl;
    pid = daemon.pid;

    saveRoomSession({
      ...session,
      serverUrl,
      publicUrl,
      adminToken,
      memberToken,
      pid,
      lastActive: Date.now(),
    });
  }

  // Compute invite URLs from the (possibly updated) server values
  const shareBase = publicUrl !== serverUrl ? publicUrl : serverUrl;
  const memberJoinUrl = buildShareUrl(shareBase, memberToken);

  // Distribute invites + post a single in-room system message for connected participants
  if (session.participants && session.participants.length > 0) {
    // connectedNames was populated by fetchServerState above (alive path).
    // Name matching is convention-based: participants are expected to join using
    // their alias as display name (as the bootstrap script and room create do).
    const allLocal = session.participants.every((p) => isLocalPath(p.cwd));
    let hasConnected = false;
    let hasDisconnected = false;

    for (const p of session.participants) {
      const connected = connectedNames.has(p.alias.toLowerCase());
      if (connected) {
        if (!hasConnected) console.log(`  ${B}Connected:${R}`);
        hasConnected = true;
        console.log(`  ${G}●${R} ${p.alias}`);
      } else {
        if (!hasDisconnected) {
          console.log(`\n  ${B}Rejoin links:${R}\n`);
          if (!tmuxAvailable() && session.participants?.some((pp) => pp.runtime)) {
            console.log(`  ${D}(tmux not found — agents will need to join manually via the invite links below)${R}\n`);
          }
        }
        hasDisconnected = true;
        console.log(`  ${W}○${R} ${p.alias}  ${D}disconnected${R}`);
        const sameHost = allLocal || isLocalPath(p.cwd);
        printInvite(p.alias, memberJoinUrl, sameHost);
        if (sameHost && tmuxAvailable() && p.runtime && !tmuxSessionExists(`apiary_${p.alias}`)) {
          const ok = spawnAgentBackground(p.alias, p.cwd, p.runtime);
          if (ok) {
            console.log(`    ${D}→ respawned ${p.runtime} session (tmux attach -t apiary_${p.alias})${R}`);
          }
        }
      }
    }

    // Single in-room system message for all connected participants at once
    if (hasConnected && alive) {
      await postSystemMessage(
        serverUrl,
        adminToken,
        `[SYSTEM] Session resumed by admin. You are still connected.`,
      );
    }
    console.log("");
  }

  console.log(`  Press Ctrl+C to leave — server keeps running.\n`);

  const { join } = await import("./join.js");
  const adminJoinUrl = buildShareUrl(serverUrl, adminToken);
  await join({ server: adminJoinUrl });

  console.log(`\n  Server still running (room: ${Y}${name}${R})`);
  console.log(`  Rejoin: ${C}apiary room resume ${name}${R}\n`);
}

// ── apiary room list ──────────────────────────────────────────────────────────

export function roomList(): void {
  const Y = "\x1b[33m";
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const C = "\x1b[36m";
  const G = "\x1b[32m";
  const X = "\x1b[31m";
  const R = "\x1b[0m";

  const sessions = listRoomSessions();
  if (sessions.length === 0) {
    console.log("  No saved rooms. Run: apiary room create");
    return;
  }

  console.log("");
  for (const s of sessions) {
    const alive = isServerAlive(s);
    const status = alive ? `${G}running${R} ${D}(PID ${s.pid})${R}` : `${X}stopped${R}`;
    const lastActive = s.lastActive
      ? `${D}last active: ${formatRelativeTime(s.lastActive)}${R}`
      : "";

    console.log(`  ${Y}${B}${s.roomName}${R}  ${status}  ${lastActive}`);

    if (s.participants && s.participants.length > 0) {
      const names = s.participants.map((p) => `${p.alias} ${D}[${p.role}]${R}`).join("  ");
      console.log(`    ${D}Participants:${R}  ${names}`);
    } else {
      console.log(`    ${D}(no participant metadata — created with older apiary)${R}`);
    }

    console.log(`    ${D}Resume:${R}  ${C}apiary room resume ${s.roomName}${R}`);
    if (alive) {
      const shareBase = s.publicUrl !== s.serverUrl ? s.publicUrl : s.serverUrl;
      const joinUrl = buildShareUrl(shareBase, s.memberToken);
      console.log(`    ${D}Join:${R}    ${C}${joinUrl}${R}`);
    }
    console.log("");
  }
}

// ── apiary room stop ──────────────────────────────────────────────────────────

export async function roomStop(name: string): Promise<void> {
  const Y = "\x1b[33m";
  const B = "\x1b[1m";
  const G = "\x1b[32m";
  const D = "\x1b[2m";
  const R = "\x1b[0m";

  const sessions = listRoomSessions();
  const session = sessions.find((s) => s.roomName === name);

  if (!session) {
    console.error(`  No saved session for room "${name}".`);
    console.error(`  Run: apiary room list  to see saved rooms.`);
    process.exit(1);
  }

  console.log(`\n  Stopping ${Y}${B}${name}${R}...\n`);

  // Kill agent tmux sessions (SIGTERM via tmux kill-session)
  if (session.participants && tmuxAvailable()) {
    for (const p of session.participants) {
      const tsName = `apiary_${p.alias}`;
      if (tmuxSessionExists(tsName)) {
        tmuxKillSession(tsName);
        console.log(`  ${G}✓${R} ${p.alias}  ${D}agent stopped${R}`);
      }
    }
  }

  // Stop server daemon
  if (isServerAlive(session)) {
    try {
      process.kill(session.pid, "SIGTERM");
      console.log(`  ${G}✓${R} server  ${D}(PID ${session.pid}) stopped${R}`);
    } catch { /* already gone */ }
  }

  removeRoomSession(name);
  console.log(`\n  Room "${name}" stopped. Start fresh: apiary room create\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isServerAlive(session: PersistedRoomSession): boolean {
  try { process.kill(session.pid, 0); return true; } catch { return false; }
}

function extractToken(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("token");
  } catch {
    return null;
  }
}

function parseDuration(input: string): number | null {
  if (!input) return null;
  const m = input.trim().match(/^(\d+)\s*(d|h|m)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "d").toLowerCase();
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "m") return n * 60 * 1000;
  return null;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
