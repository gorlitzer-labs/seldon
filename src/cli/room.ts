/**
 * apiary room create / resume / list
 *
 * Interactive room management — the human-friendly entry point.
 * Daemon pattern: server spawns as a detached child process so the TUI
 * can exit (Ctrl+C) without killing the room.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { createInterface } from "node:readline";

import { buildShareUrl } from "./auth.js";
import { agentEmoji, roomEmoji } from "./config.js";
import { askRepoPath, askRuntime, shortenPath } from "./repoPicker.js";
import type { AuthorityLevel } from "../core/types.js";
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

// ── Alias-spec parser ────────────────────────────────────────────────────────
//
// The wizard accepts `alias[:token][:token...]` where each suffix token
// modifies one independent axis:
//   - type:  `human` (default `agent`)
//   - tier:  `owner` (= product_owner), `admin`, `guest` (default `member`)
//   - role:  any unrecognized token is preserved as a cosmetic role label.
//
// Examples:
//   `cane`              → agent / member
//   `bob:human`         → human / member
//   `cane:owner`        → agent / product_owner ("the agent in charge")
//   `bob:human:admin`   → human / admin
//   `cane:owner:human`  → human / product_owner (order doesn't matter)

const TIER_TOKENS: Record<string, AuthorityLevel> = {
  owner: "product_owner",
  product_owner: "product_owner",
  admin: "admin",
  member: "member",
  guest: "guest",
};
const TYPE_TOKENS: Record<string, "agent" | "human"> = {
  agent: "agent",
  human: "human",
};

function parseAliasSpec(input: string): {
  alias: string;
  type: "agent" | "human";
  tier: AuthorityLevel;
  role: string;
} | null {
  const parts = input.split(":").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const alias = parts[0];
  let type: "agent" | "human" = "agent";
  let tier: AuthorityLevel = "member";
  let role = "agent";
  for (const tok of parts.slice(1)) {
    const lc = tok.toLowerCase();
    if (TYPE_TOKENS[lc]) {
      type = TYPE_TOKENS[lc];
      role = type;
    } else if (TIER_TOKENS[lc]) {
      tier = TIER_TOKENS[lc];
    } else {
      role = lc;
    }
  }
  return { alias, type, tier, role };
}

function makePrompt(): Prompter {
  // Per-question readline: open → ask → close. Lets the repo picker (which
  // toggles raw mode on stdin) own input cleanly between questions, with no
  // listener contention from a long-lived readline interface.
  return {
    ask: (q: string) => new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => {
        rl.close();
        res(a.trim());
      });
    }),
    close: () => {},
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

export interface DaemonSpawnFailure {
  reason: string;          // human-readable summary
  stderr?: string;         // raw child stderr if captured
  portInUse?: boolean;     // EADDRINUSE on the requested port
}

export async function spawnDaemonServer(opts: {
  room?: string;
  port?: number;
  share?: boolean;
  expose?: boolean;
  shareTtlMs?: number;
}): Promise<DaemonResult | DaemonSpawnFailure> {
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

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const settle = (v: DaemonResult | DaemonSpawnFailure) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const line = stdoutBuf.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        try {
          const result = JSON.parse(line.trim());
          child.unref();
          settle({ ...result, pid: child.pid! });
        } catch {
          /* keep buffering */
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    child.on("error", (err) => settle({ reason: err.message, stderr: stderrBuf }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const portInUse = /EADDRINUSE|already in use/i.test(stderrBuf);
        settle({
          reason: portInUse
            ? `port ${opts.port ?? 7890} already in use`
            : `daemon exited with code ${code}`,
          stderr: stderrBuf,
          portInUse,
        });
      }
    });
    setTimeout(() => settle({ reason: "timed out waiting for daemon startup", stderr: stderrBuf }), 15_000);
  });
}

/** Type guard — `true` if spawnDaemonServer returned a successful DaemonResult. */
export function isDaemonResult(v: DaemonResult | DaemonSpawnFailure): v is DaemonResult {
  return "serverUrl" in v;
}

// ── Invite file helpers ───────────────────────────────────────────────────────

export function writeInvite(alias: string, joinUrl: string): void {
  mkdirSync(INVITES_DIR, { recursive: true });
  writeFileSync(pathJoin(INVITES_DIR, alias), joinUrl, { mode: 0o600 });
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

// ── Runtime detection ─────────────────────────────────────────────────────────

// Unix/macOS only — `which` is not available on Windows; both return false there (graceful, no auto-spawn).
function detectRuntimes(): { claude: boolean; codex: boolean } {
  const has = (cmd: string) => {
    try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
  };
  return { claude: has("claude"), codex: has("codex") };
}

// ── ASCII bee banner ──────────────────────────────────────────────────────────

const A = "\x1b[33m";  // amber
const RESET = "\x1b[0m";

const BEE_BANNER = [
  `${A}               _                      \\ \\${RESET}`,
  `${A}  ____ _____  (_)___ ________  __      \\ \\ \\${RESET}`,
  `${A} / __ \`/ __ \\/ / __ \`/ ___/ / / /      (o o)${RESET}`,
  `${A}/ /_/ / /_/ / / /_/ / /  / /_/ /       )=BzZz=(${RESET}`,
  `${A}\\__,_/ .___/_/\\__,_/_/   \\__, /        / / /${RESET}`,
  `${A}    /_/                 /____/        / / /${RESET}`,
].join("\n");

// ── Agent background spawn ────────────────────────────────────────────────────

/**
 * Spawn `apiary <runtime> <alias> --background` as a detached child process in
 * the participant's cwd. The child creates its own tmux session and runs until
 * SIGTERM (sent by `roomStop`).
 *
 * Returns true on success, false if the cwd doesn't exist or spawn fails.
 */
function spawnAgentBackground(
  alias: string,
  cwd: string,
  runtime: string,
  tier: AuthorityLevel = "member",
): boolean {
  const resolvedCwd = cwd.replace(/^~/, homedir());
  if (!existsSync(resolvedCwd)) return false;
  // For agents at admin or product_owner tier, pass --admin so the local MCP
  // server exposes the privileged tool set. The server still enforces the
  // real tier via the share token; --admin only affects which tools the
  // agent's process *advertises*.
  const args = [process.argv[1], runtime, alias, "--background"];
  if (tier === "admin" || tier === "product_owner") args.push("--admin");
  try {
    const child = spawn(process.execPath, args, {
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

/**
 * Mint share tokens for each non-member tier the wizard needs. Opens a single
 * transient admin session, posts to `/share` once per tier, then disconnects.
 *
 * Returns a map { tier → join URL } for the tiers successfully minted. Tiers
 * that fail to mint (network error, server rejects) are omitted; the caller
 * falls back to the member URL.
 */
async function mintTierTokens(
  serverUrl: string,
  adminShareToken: string,
  shareBase: string,
  tiers: AuthorityLevel[],
): Promise<Partial<Record<AuthorityLevel, string>>> {
  const result: Partial<Record<AuthorityLevel, string>> = {};
  const sessionToken = await httpJoin(serverUrl, adminShareToken, "[system]");
  if (!sessionToken) return result;
  try {
    for (const tier of tiers) {
      try {
        const res = await fetch(`${serverUrl}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ authority: tier }),
        });
        if (!res.ok) continue;
        const data = await res.json() as { links?: Record<string, string>; token?: string };
        // Some endpoints return a token; others a URL. Handle both.
        const linkForTier = data.links?.[tier];
        const token = linkForTier ? extractToken(linkForTier) : data.token;
        if (token) result[tier] = buildShareUrl(shareBase, token);
      } catch {
        /* tier failed — skip; caller falls back to memberJoinUrl */
      }
    }
  } finally {
    await httpDisconnect(serverUrl, sessionToken);
  }
  return result;
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

  console.log(`\n${BEE_BANNER}\n`);
  console.log(`  ${Y}${B}apiary${R} — create room\n`);

  const roomName = opts.room ?? ((await ask(`  Room name ${D}[random]${R}: `)) || undefined);

  const ttlInput = await ask(`  Session duration ${D}[7d]${R}: `);
  const shareTtlMs = parseDuration(ttlInput) ?? DAEMON_SHARE_TTL_MS;

  const rts = detectRuntimes();
  const availableRuntimes = [...(rts.claude ? ["claude"] : []), ...(rts.codex ? ["codex"] : [])];
  if (availableRuntimes.length === 0) {
    console.log(`\n  ${D}(neither claude nor codex found in PATH — agents will need to join manually)${R}`);
  } else if (availableRuntimes.length === 1) {
    console.log(`\n  ${D}Runtime auto-detected: ${availableRuntimes[0]}${R}`);
  }

  const participants: Array<{
    alias: string;
    cwd: string;
    role: string;
    runtime?: string;
    tier: AuthorityLevel;
  }> = [];
  const G = "\x1b[32m";
  const M = "\x1b[35m";
  const divider = `  ${D}${"─".repeat(56)}${R}`;
  console.log(`\n  ${B}Invite participants${R}`);
  console.log(divider);
  while (true) {
    const n = participants.length + 1;
    console.log(`\n  🐝 ${M}${B}Participant ${n}${R}`);
    const aliasInput = await ask(
      `     ${C}→${R} Alias ${D}(blank ↵ to finish · suffix :human, :owner, :admin, :guest)${R}: `,
    );
    if (!aliasInput) {
      const count = participants.length;
      const summary = count === 0
        ? `${D}no participants — starting an empty room${R}`
        : `${G}✓${R} ${B}${count}${R} participant${count === 1 ? "" : "s"} ready — starting room…`;
      console.log(`  ${summary}`);
      break;
    }
    const spec = parseAliasSpec(aliasInput);
    if (!spec) continue;
    const { alias, role, tier } = spec;
    const cwd = await askRepoPath({ alias, defaultPath: process.cwd(), ask });
    const runtime = role === "agent"
      ? await askRuntime({ alias, available: availableRuntimes, ask })
      : undefined;
    participants.push({ alias, cwd, role, runtime, tier });
    const bug = role === "agent" ? agentEmoji(alias) : role === "human" ? "👤" : "✎";
    const runtimeBadge = runtime ? ` · ${C}${runtime}${R}` : "";
    const tierBadge = tier !== "member" ? `  ${Y}[${tier === "product_owner" ? "owner" : tier}]${R}` : "";
    console.log(
      `  ${G}✅${R} ${bug} ${B}${alias}${R}${tierBadge}  ${D}${role}${R}${runtimeBadge}  ${D}${shortenPath(cwd)}${R}`,
    );
    console.log(divider);
  }

  close();

  console.log(`\n  Starting server in background...`);

  const daemonRes = await spawnDaemonServer({
    room: roomName,
    port: opts.port,
    share: opts.share,
    expose: opts.expose,
    shareTtlMs,
  });
  if (!isDaemonResult(daemonRes)) {
    console.error(`\n  ${Y}✗${R} Failed to start server: ${B}${daemonRes.reason}${R}`);
    if (daemonRes.portInUse) {
      console.error(`  ${D}A previous room daemon is probably still bound. Inspect with:${R}  ${C}apiary ps${R}`);
      console.error(`  ${D}Stop it with:${R}  ${C}apiary stop --all${R}  ${D}(or ${R}${C}apiary stop <room>${R}${D})${R}`);
    } else if (daemonRes.stderr?.trim()) {
      console.error(`  ${D}stderr:${R}\n${daemonRes.stderr.split("\n").map((l) => "    " + l).join("\n")}`);
    }
    process.exit(1);
  }
  const daemon = daemonRes;

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

  // Mint per-tier share tokens for any participant whose tier isn't "member".
  // The daemon's startup payload only includes adminToken + memberToken; we
  // need a fresh token per non-default tier. POST /share with the admin
  // session — once per distinct tier — covers every participant cheaply.
  const tieredJoinUrls: Partial<Record<AuthorityLevel, string>> = { member: memberJoinUrl };
  const nonMemberTiers = Array.from(
    new Set(participants.map((p) => p.tier).filter((t) => t !== "member")),
  );
  if (nonMemberTiers.length > 0) {
    const mintedUrls = await mintTierTokens(daemon.serverUrl, daemon.adminToken, shareBase, nonMemberTiers);
    Object.assign(tieredJoinUrls, mintedUrls);
  }

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
      const joinUrl = tieredJoinUrls[p.tier] ?? memberJoinUrl;
      printInvite(p.alias, joinUrl, sameHost);
      if (sameHost && canSpawn && p.runtime) {
        const ok = spawnAgentBackground(p.alias, p.cwd, p.runtime, p.tier);
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

  console.log(`\n  Server still running ${roomEmoji(daemon.roomName)} ${Y}${daemon.roomName}${R}`);
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

    const daemonRes = await spawnDaemonServer({ room: name });
    if (!isDaemonResult(daemonRes)) {
      console.error(`\n  ${W}✗${R} Failed to restart server: ${B}${daemonRes.reason}${R}`);
      if (daemonRes.portInUse) {
        console.error(`  ${D}Inspect:${R}  ${C}apiary ps${R}    ${D}Stop:${R}  ${C}apiary stop --all${R}`);
      } else if (daemonRes.stderr?.trim()) {
        console.error(`  ${D}stderr:${R}\n${daemonRes.stderr.split("\n").map((l) => "    " + l).join("\n")}`);
      }
      process.exit(1);
    }
    const daemon = daemonRes;

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
