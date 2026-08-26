/**
 * apiary serve — dumb room server.
 *
 * One room, one HTTP API, SSE broadcasting, authority enforcement.
 * No EventProcessor, no tmux, no agent lifecycle — those live client-side.
 * Humans connect via `apiary join`, agents via `apiary run claude`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, networkInterfaces } from "node:os";
import { join as pathJoin, resolve, sep } from "node:path";

import { Room } from "../core/room.js";
import { InMemoryStorage, FileBackedStorage } from "../core/storage.js";
import { randomRoomName, randomName } from "../core/names.js";
import { createEvent, type ActivityEvent, type AuthorityChangedEvent, type ParticipantKickedEvent, type RoomClearedEvent, type RoomEvent, type RulesChangedEvent, type StatusChangedEvent, type WhisperNotifiedEvent } from "../core/events.js";
import { loadRulesForRoom, saveRulesForRoom, seedRulesIfMissing, roomRulesPath, RULES_MAX } from "../core/rules.js";
import { watchFile, unwatchFile, type Stats } from "node:fs";
import { AttachmentSchema } from "../core/types.js";
import type { AuthorityLevel, Attachment } from "../core/types.js";
import { can } from "../core/authority.js";
import type { Channel } from "../core/channel.js";
import { formatTimestamp } from "../agent/prompts.js";
import { TokenManager, buildShareUrl } from "./auth.js";
import { roomEmoji } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectedParticipant {
  id: string;
  name: string;
  authority: AuthorityLevel;
  channel: Channel;
  sessionToken: string;
}

interface ConnectedGuest {
  id: string;
  authority: "guest";
  channel: Channel;
  sessionToken: string;
}

export interface ServeOptions {
  room?: string;
  port?: number;
  share?: boolean;
  quiet?: boolean;
  /** Suppress all human-readable output; emit one JSON line with server info on stdout. */
  headless?: boolean;
  /** Path to save room state to (JSON file, written on every event). */
  save?: string;
  /** Path to load room state from (JSON file). Implies save to the same file. */
  load?: string;
  /** Bind to 0.0.0.0 instead of 127.0.0.1. Required for non-localhost access. */
  expose?: boolean;
  /** Allowed CORS origins (in addition to localhost and tunnel URL). */
  corsOrigins?: string[];
  /** Share token TTL in ms. Defaults to 24h; use a longer value for persistent sessions. */
  shareTtlMs?: number;
}

export interface ServeResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
}

// ── Room session persistence ─────────────────────────────────────────────────

export const SESSION_DIR = pathJoin(homedir(), ".apiary", "sessions");
export const INVITES_DIR = pathJoin(homedir(), ".apiary", "invites");

export interface PersistedRoomSession {
  roomName: string;
  serverUrl: string;
  publicUrl: string;
  adminToken: string;
  memberToken: string;
  pid: number;
  /** Unix timestamp of last TUI activity (set by room create/resume). */
  lastActive?: number;
  /**
   * Display name the host used at create time (e.g. "Franco"). roomResume
   * restores this so the admin keeps a consistent identity across reconnects —
   * otherwise the human gets a random name and agents can't recognize them.
   */
  hostName?: string;
  /** Participants recorded at create/resume time. */
  participants?: Array<{
    alias: string;
    cwd: string;
    role: string;
    runtime?: string;
    /**
     * Authority tier this participant joined at. Set by `apiary room create`
     * via alias-suffix grammar (e.g. `cane:owner`). Undefined = member.
     */
    tier?: AuthorityLevel;
    /**
     * Model id passed to the runtime (`--model` for claude). Set by alias-suffix
     * grammar (e.g. `bf:opus`, `anvil:sonnet`). Undefined = runtime default.
     */
    model?: string;
  }>;
}

function roomSessionPath(name: string): string {
  return pathJoin(SESSION_DIR, `room_${name}.json`);
}

export function saveRoomSession(session: PersistedRoomSession): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(roomSessionPath(session.roomName), JSON.stringify(session, null, 2));
}

function clearRoomSession(name: string): void {
  try { rmSync(roomSessionPath(name)); } catch { /* ok */ }
}

export function listRoomSessions(): PersistedRoomSession[] {
  if (!existsSync(SESSION_DIR)) return [];
  const files = readdirSync(SESSION_DIR) as string[];
  const sessions: PersistedRoomSession[] = [];
  for (const f of files) {
    if (!f.startsWith("room_") || !f.endsWith(".json")) continue;
    try {
      sessions.push(JSON.parse(readFileSync(pathJoin(SESSION_DIR, f), "utf-8")));
    } catch { /* skip */ }
  }
  return sessions;
}

export function removeRoomSession(name: string): void {
  try { rmSync(pathJoin(SESSION_DIR, `room_${name}.json`)); } catch { /* ok */ }
}

// ── SSE helper ───────────────────────────────────────────────────────────────

async function enrichAndSend(res: ServerResponse, event: RoomEvent, room: Room): Promise<void> {
  if (event.type === "MessageSent" && event.message.reply_to_id) {
    const replyMsg = await room.getMessage(event.message.reply_to_id);
    const enriched = {
      ...event,
      _replyToName: replyMsg?.sender_name ?? null,
    };
    res.write(`data: ${JSON.stringify(enriched)}\n\n`);
    return;
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Main serve command ───────────────────────────────────────────────────────

const ROOMS_DIR = pathJoin(homedir(), ".apiary", "rooms");

function validateSavePath(p: string): string {
  const resolved = resolve(p);
  if (!resolved.endsWith(".json")) throw new Error("Save/load path must end with .json");
  const cwd = process.cwd();
  const tmp = tmpdir();
  const apiaryDir = pathJoin(homedir(), ".apiary");
  if (!resolved.startsWith(cwd + sep) && !resolved.startsWith(tmp + sep) && !resolved.startsWith(apiaryDir + sep))
    throw new Error(`Path must be under ${cwd}, ${tmp}, or ${apiaryDir}`);
  return resolved;
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const roomName = options.room ?? randomRoomName();
  const port = options.port ?? 7890;
  const lanIp = options.expose ? getLanIp() : null;
  const serverUrl = `http://${lanIp ?? "127.0.0.1"}:${port}`;
  const log = options.headless ? () => {} : logServer;

  let publicUrl = serverUrl;
  let tunnelProcess: ChildProcess | null = null;

  // Validate save/load paths
  if (options.save) options.save = validateSavePath(options.save);
  if (options.load) options.load = validateSavePath(options.load);

  // Create room with persistence
  // Default: ~/.apiary/rooms/<room>.json — auto-resumes previous session.
  // Explicit --save/--load overrides the default.
  mkdirSync(ROOMS_DIR, { recursive: true });
  const defaultPath = pathJoin(ROOMS_DIR, `${roomName}.json`);
  const savePath = options.save ?? options.load ?? defaultPath;
  const shouldAutoLoad = !options.save && !options.load && existsSync(defaultPath);
  let storage;
  if (options.load || shouldAutoLoad) {
    const loadPath = options.load ?? defaultPath;
    try {
      storage = await FileBackedStorage.load(loadPath);
      log(`loaded room state from ${loadPath}`);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        storage = new FileBackedStorage(loadPath);
        log(`no existing file at ${loadPath}, starting fresh`);
      } else {
        throw err;
      }
    }
  } else {
    storage = new FileBackedStorage(savePath);
  }
  const room = new Room(roomName, storage);

  // ── Rules ─────────────────────────────────────────────────────────────────
  // Seed defaults on first boot, then watch the file so hand-edits hot-reload
  // and broadcast `RulesChanged` to every connected SSE client. The current
  // ruleset is held in-memory and re-served on `GET /rules` to avoid disk
  // I/O on the hot path.
  seedRulesIfMissing(roomName);
  let currentRules = loadRulesForRoom(roomName);
  const rulesFilePath = roomRulesPath(roomName);
  const onRulesFileChange = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs === prev.mtimeMs) return; // spurious event
    try {
      const next = loadRulesForRoom(roomName);
      // Skip no-op reloads (same content). Cheap stringify for short lists.
      if (JSON.stringify(next) === JSON.stringify(currentRules)) return;
      currentRules = next;
      broadcastRulesChanged(currentRules, "[system]");
      log(`rules reloaded from disk (${currentRules.length} rules)`);
    } catch {
      /* corrupt mid-edit — ignore, next save will fire again */
    }
  };
  watchFile(rulesFilePath, { interval: 2000 }, onRulesFileChange);

  // Auth
  const tokens = new TokenManager({ shareTtlMs: options.shareTtlMs });

  // Connected participants and guests (by session token for lookup)
  const participants = new Map<string, ConnectedParticipant>();
  const guests = new Map<string, ConnectedGuest>();
  // Reverse lookup: participantId → sessionToken
  const idToSession = new Map<string, string>();

  // Track active SSE connections for cleanup
  const sseConnections = new Map<string, ServerResponse>();

  // ── Presence tracking ────────────────────────────────────────────────────
  // Updated on every SSE write (heartbeat or event) and every authenticated HTTP request.
  const lastSeenAt = new Map<string, number>();           // participantId → ms timestamp
  const presenceStatus = new Map<string, "online" | "unresponsive" | "offline">();

  // Configurable thresholds (overridable via env for testing or custom deployments).
  // Both are measured from `lastSeenAt` (last proof of life), not from each other.
  // Default: unresponsive at 90s, offline at 180s from last activity.
  const UNRESPONSIVE_AFTER_MS = parseInt(process.env.APIARY_UNRESPONSIVE_MS ?? "90000", 10);
  const OFFLINE_AFTER_MS = parseInt(process.env.APIARY_OFFLINE_MS ?? String(UNRESPONSIVE_AFTER_MS * 2), 10);
  const PRESENCE_CHECK_INTERVAL_MS = parseInt(process.env.APIARY_PRESENCE_CHECK_MS ?? "30000", 10);

  function touchParticipant(id: string): void {
    lastSeenAt.set(id, Date.now());
  }

  function broadcastStatusChange(
    participantId: string,
    name: string,
    status: "online" | "unresponsive" | "offline",
    previousStatus: "online" | "unresponsive" | "offline",
    reason: "ping_timeout" | "recovered" | "left" | "kicked",
  ): void {
    const event = createEvent<StatusChangedEvent>({
      type: "StatusChanged",
      category: "PRESENCE",
      room_id: room.roomId,
      participant_id: participantId,
      name,
      status,
      previous_status: previousStatus,
      reason,
    });
    for (const [, sseRes] of sseConnections) {
      sseRes.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  function broadcastRulesChanged(rules: string[], updatedBy: string): void {
    const event = createEvent<RulesChangedEvent>({
      type: "RulesChanged",
      category: "ACTIVITY",
      room_id: room.roomId,
      participant_id: "[system]",
      rules,
      updated_by: updatedBy,
    });
    for (const [, sseRes] of sseConnections) {
      sseRes.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  // ── Attachment storage ───────────────────────────────────────────────────
  // In-memory, room-scoped. Cleared when the room is cleared or server restarts.

  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per upload
  // Hard cap on the in-memory store. When uploads would push us over, evict
  // the oldest attachments (FIFO by upload timestamp) until there is room.
  // Without this, a long-running room with image uploads OOMs the daemon.
  const MAX_ATTACHMENT_STORE_BYTES = 256 * 1024 * 1024; // 256 MB total

  interface StoredAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    roomId: string;
    bytes: Buffer;
    uploadedAt: number; // ms epoch — used for FIFO eviction
  }

  // Map preserves insertion order — iteration yields oldest-first, which is
  // exactly what we want for FIFO eviction.
  const attachmentStore = new Map<string, StoredAttachment>();
  let attachmentStoreBytes = 0;

  function evictAttachmentsToFit(neededBytes: number): void {
    if (neededBytes > MAX_ATTACHMENT_STORE_BYTES) return; // caller will reject — no point evicting everything
    while (attachmentStoreBytes + neededBytes > MAX_ATTACHMENT_STORE_BYTES) {
      const oldest = attachmentStore.entries().next();
      if (oldest.done) break;
      const [oldestId, oldestAtt] = oldest.value;
      attachmentStore.delete(oldestId);
      attachmentStoreBytes -= oldestAtt.size;
    }
  }

  function attachmentUrl(id: string): string {
    return `${publicUrl}/attachment/${id}`;
  }

  // ── JSON body parser helper ──────────────────────────────────────────────

  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
  }

  // ── Auth helper ──────────────────────────────────────────────────────────

  function extractSessionToken(req: IncomingMessage, url: URL, body?: Record<string, unknown>): string | null {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7);
    // Fallback: query param / body (deprecated)
    return url.searchParams.get("token") ?? (body?.token ? String(body.token) : null);
  }

  function getSession(token: string | null) {
    if (!token) return null;
    const p = participants.get(token);
    if (p) return { ...p, kind: "participant" as const };
    const g = guests.get(token);
    if (g) return { ...g, kind: "guest" as const };
    return null;
  }

  function clampInt(val: string | null, def: number, min: number, max: number): number {
    const n = parseInt(val ?? String(def), 10);
    return isNaN(n) ? def : Math.max(min, Math.min(max, n));
  }

  function jsonError(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  }

  function jsonOk(res: ServerResponse, data: Record<string, unknown> = {}): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...data }));
  }

  // ── CORS helper ────────────────────────────────────────────────────────

  const allowedOrigins = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(options.corsOrigins ?? []),
  ]);

  function addCorsOrigin(origin: string): void {
    allowedOrigins.add(origin);
  }

  function getCorsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (allowedOrigins.has(origin)) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      };
    }
    return {};
  }

  // ── Rate limiter ────────────────────────────────────────────────────────

  class RateLimiter {
    private _buckets = new Map<string, { count: number; resetAt: number }>();
    private _opsSincePrune = 0;
    constructor(private _max: number, private _windowMs: number) {}
    check(key: string): { allowed: boolean; retryAfter?: number } {
      const now = Date.now();
      // Opportunistic prune: every 256 ops, drop expired buckets so the map
      // can't grow forever from one-off keys (rotating IPs, dead sessions).
      if (++this._opsSincePrune >= 256) {
        this._opsSincePrune = 0;
        for (const [k, b] of this._buckets) {
          if (now >= b.resetAt) this._buckets.delete(k);
        }
      }
      const bucket = this._buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        this._buckets.set(key, { count: 1, resetAt: now + this._windowMs });
        return { allowed: true };
      }
      if (bucket.count >= this._max) {
        return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
      }
      bucket.count++;
      return { allowed: true };
    }
  }

  const joinLimiter = new RateLimiter(10, 60_000);       // 10/min per IP
  const messageLimiter = new RateLimiter(30, 60_000);     // 30/min per session
  const shareLimiter = new RateLimiter(10, 60_000);       // 10/min per session
  const getLimiter = new RateLimiter(60, 60_000);          // 60/min per session
  const sseLimiter = new RateLimiter(5, 60_000);           // 5/min per IP

  function getClientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  function rateLimitError(res: ServerResponse, retryAfter: number): void {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
    });
    res.end(JSON.stringify({ error: "Too many requests" }));
  }

  // ── HTTP API ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // ── CORS preflight ───────────────────────────────────────────────────
    if (req.method === "OPTIONS") {
      const corsHeaders = getCorsHeaders(req);
      if (Object.keys(corsHeaders).length > 0) {
        res.writeHead(204, corsHeaders);
      } else {
        res.writeHead(204);
      }
      res.end();
      return;
    }

    // Apply CORS headers to all responses
    const corsHeaders = getCorsHeaders(req);
    for (const [k, v] of Object.entries(corsHeaders)) {
      res.setHeader(k, v);
    }

    // ── SSE event stream ───────────────────────────────────────────────────
    // ⚠️  MUST accept POST — DO NOT change to GET-only.
    // Cloudflare Quick Tunnels buffer GET streaming responses and only flush
    // when the connection closes. POST streams in real-time. (cloudflared#1449)
    // https://github.com/cloudflare/cloudflared/issues/1449
    if (url.pathname === "/events" && (req.method === "GET" || req.method === "POST")) {
      const sseCheck = sseLimiter.check(getClientIp(req));
      if (!sseCheck.allowed) return rateLimitError(res, sseCheck.retryAfter!);

      const authHeader = req.headers.authorization;
      const sessionToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      const session = getSession(sessionToken);

      if (!session) {
        jsonError(res, 401, "Invalid session token");
        return;
      }

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.flushHeaders();

      // Disable Nagle's algorithm so SSE events flush immediately.
      // Without this, small writes may be delayed up to ~200ms waiting
      // for more data, which can cause events to appear "stuck" until
      // the next event (e.g. a MentionedEvent) pushes the buffer.
      res.socket?.setNoDelay(true);

      sseConnections.set(session.id, res);

      // Initialize or recover presence for participants (not guests).
      // Recover from both "unresponsive" and "offline" (timeout case — session is
      // still valid). Left/kicked participants can't reach here: their session token
      // is revoked and getSession() returns null → 401 above.
      if (session.kind === "participant") {
        touchParticipant(session.id);
        const prev = presenceStatus.get(session.id);
        if (prev === "unresponsive" || prev === "offline") {
          presenceStatus.set(session.id, "online");
          broadcastStatusChange(session.id, session.name, "online", prev, "recovered");
          log(`${session.name} recovered`);
        } else if (!prev) {
          presenceStatus.set(session.id, "online");
        }
      }

      // Heartbeat every 30s to keep the connection alive through
      // proxies, firewalls, and OS-level TCP idle timeouts.
      //
      // If the write fails (broken socket, client crashed, network died), the
      // OS may not have surfaced the close event yet — treat the failure as a
      // disconnect so the entry isn't left dangling in sseConnections forever.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        sseConnections.delete(session.id);
        try { res.end(); } catch { /* already gone */ }
      };
      const heartbeat = setInterval(() => {
        try {
          const ok = res.write(":heartbeat\n\n");
          if (!ok && res.destroyed) { cleanup(); return; }
        } catch {
          cleanup();
          return;
        }
        // SSE heartframe counts as proof of life — prevents false-positive
        // unresponsive for read-only agents that have no HTTP activity.
        if (session.kind === "participant") touchParticipant(session.id);
      }, 30_000);

      // Send recent history so the joiner has context.
      // Whispers are filtered: only deliver if this participant is sender or recipient.
      const history = await room.listEvents(undefined, 50);
      for (const event of [...history.items].reverse()) {
        if (event.type === "MessageSent" && (event.message.recipients?.length ?? 0) > 0) {
          const isParticipant = event.message.recipients!.includes(session.id) || event.message.sender_id === session.id;
          if (!isParticipant) continue;
        }
        await enrichAndSend(res, event, room);
      }

      // Live event stream.
      // Whispers: the full MessageSentEvent is filtered here for non-participants;
      // the WhisperNotifiedEvent is sent directly to them at POST /message time.
      const streamEvents = async () => {
        try {
          for await (const event of session.channel) {
            if (event.type === "MessageSent" && (event.message.recipients?.length ?? 0) > 0) {
              const isParticipant = event.message.recipients!.includes(session.id) || event.message.sender_id === session.id;
              if (!isParticipant) continue;
            }
            await enrichAndSend(res, event, room);
            if (session.kind === "participant") touchParticipant(session.id);
          }
        } catch {
          // Channel disconnected
        }
      };
      streamEvents();

      // Cleanup on client disconnect (covers the normal-close path; abnormal
      // disconnects are handled by the heartbeat catch above).
      req.on("close", cleanup);
      return;
    }

    // ── GET endpoints ─────────────────────────────────────────────────────

    if (req.method === "GET") {
      const sessionToken = extractSessionToken(req, url);
      const session = getSession(sessionToken);
      if (sessionToken) {
        const getCheck = getLimiter.check(sessionToken);
        if (!getCheck.allowed) return rateLimitError(res, getCheck.retryAfter!);
      }
      if (session && session.kind === "participant") touchParticipant(session.id);

      // ── GET /participants ────────────────────────────────────────────────
      if (url.pathname === "/participants") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const list = room.listParticipants().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          authority: p.authority ?? "member",
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ participants: list }));
        return;
      }

      // ── GET /rules ───────────────────────────────────────────────────────
      // Any authenticated participant (including guests) can read the rules.
      if (url.pathname === "/rules") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ rules: currentRules }));
        return;
      }

      // ── GET /message/:id ─────────────────────────────────────────────────
      if (url.pathname.startsWith("/message/")) {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const messageId = url.pathname.slice("/message/".length);
        const msg = await room.getMessage(messageId);
        if (!msg) return jsonError(res, 404, "Message not found");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: msg }));
        return;
      }

      // ── GET /messages ────────────────────────────────────────────────────
      if (url.pathname === "/messages") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const count = clampInt(url.searchParams.get("count"), 30, 1, 100);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.listMessages(count, cursor);
        // Filter whispers: only include if sender or recipient.
        // Undefined session.id → no whispers shown (safe default: fail closed).
        const filtered = {
          ...result,
          items: result.items.filter((m) => {
            if (!(m.recipients?.length)) return true;
            if (!session.id) return false;
            return m.sender_id === session.id || m.recipients.includes(session.id);
          }),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(filtered));
        return;
      }

      // ── GET /events/history ──────────────────────────────────────────────
      if (url.pathname === "/events/history") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const category = url.searchParams.get("category") ?? null;
        const count = clampInt(url.searchParams.get("count"), 50, 1, 200);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.listEvents(category as any, count, cursor);
        // Filter whispers from event history: same rules as GET /messages.
        // Undefined session.id → no whispers shown (safe default: fail closed).
        const filteredEvents = {
          ...result,
          items: result.items.filter((e) => {
            if (e.type !== "MessageSent" || !(e.message.recipients?.length)) return true;
            if (!session.id) return false;
            return e.message.sender_id === session.id || e.message.recipients.includes(session.id);
          }),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(filteredEvents));
        return;
      }

      // ── GET /search ──────────────────────────────────────────────────────
      if (url.pathname === "/search") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const query = url.searchParams.get("query") ?? "";
        if (!query) return jsonError(res, 400, "Missing query parameter");
        const count = clampInt(url.searchParams.get("count"), 10, 1, 50);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.searchMessages(query, count, cursor);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // ── GET /attachment/:id ──────────────────────────────────────────────
      if (url.pathname.startsWith("/attachment/")) {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const id = url.pathname.slice("/attachment/".length);
        const stored = attachmentStore.get(id);
        if (!stored) return jsonError(res, 404, "Attachment not found");
        res.writeHead(200, {
          "Content-Type": stored.mimeType,
          "Content-Length": String(stored.size),
          "Content-Disposition": `inline; filename="${stored.name}"`,
        });
        res.end(stored.bytes);
        return;
      }
    }

    // ── POST /attachment — raw bytes, must come before parseBody ────────────

    if (req.method === "POST" && url.pathname === "/attachment") {
      const attSessionToken = extractSessionToken(req, url);
      const attSession = getSession(attSessionToken);
      if (!attSession) return jsonError(res, 401, "Invalid session token");
      if (!can(attSession.authority, "send_message")) return jsonError(res, 403, "Guests cannot upload attachments");

      // Raw body read (intentionally not parseBody — binary, not JSON).
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooBig = false;
      for await (const chunk of req) {
        totalBytes += (chunk as Buffer).length;
        if (totalBytes > MAX_ATTACHMENT_BYTES) { tooBig = true; break; }
        chunks.push(chunk as Buffer);
      }
      if (tooBig) return jsonError(res, 413, `Attachment too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`);

      const bytes = Buffer.concat(chunks);
      const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const disposition = req.headers["content-disposition"] ?? "";
      const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
      const rawName =
        filenameMatch?.[1]?.trim() ??
        (req.headers["x-filename"] as string | undefined) ??
        "attachment";
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }

      const id = randomUUID();
      evictAttachmentsToFit(bytes.length);
      attachmentStore.set(id, {
        id, name, mimeType, size: bytes.length, roomId: room.roomId, bytes,
        uploadedAt: Date.now(),
      });
      attachmentStoreBytes += bytes.length;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, url: attachmentUrl(id), name, mime_type: mimeType, size: bytes.length }));
      return;
    }

    // ── PUT /rules — admin updates the ruleset ────────────────────────────

    if (req.method === "PUT" && url.pathname === "/rules") {
      const sessionToken = extractSessionToken(req, url);
      const session = getSession(sessionToken);
      if (!session) return jsonError(res, 401, "Invalid session token");
      if (!can(session.authority, "clear_history")) {
        return jsonError(res, 403, "Only admins can update rules");
      }
      const body = await parseBody(req);
      const rawRules = body.rules;
      if (!Array.isArray(rawRules) || rawRules.some((r) => typeof r !== "string")) {
        return jsonError(res, 400, "Body must be { rules: string[] }");
      }
      const cleaned = (rawRules as string[])
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
        .slice(0, RULES_MAX);
      currentRules = cleaned;
      saveRulesForRoom(roomName, currentRules);
      const adminP = sessionToken ? participants.get(sessionToken) : undefined;
      broadcastRulesChanged(currentRules, adminP?.name ?? "admin");
      log(`rules updated by ${adminP?.name ?? session.id} (${currentRules.length} rules)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rules: currentRules }));
      return;
    }

    // ── POST endpoints ────────────────────────────────────────────────────

    if (req.method === "POST") {
      const body = await parseBody(req);

      // ── POST /join ──────────────────────────────────────────────────────
      if (url.pathname === "/join") {
        const joinCheck = joinLimiter.check(getClientIp(req));
        if (!joinCheck.allowed) return rateLimitError(res, joinCheck.retryAfter!);

        // Accept share token (body.shareToken preferred, body.token as fallback)
        const shareToken = String(body.shareToken ?? body.token ?? "");
        const legacyType = String(body.type ?? "");

        let authority: AuthorityLevel;

        if (shareToken) {
          const tokenAuthority = tokens.validateShareToken(shareToken);
          if (!tokenAuthority) return jsonError(res, 403, "Invalid share token");
          authority = tokenAuthority;
        } else if (legacyType === "guest") {
          authority = "guest";
        } else {
          // Default: joins as member
          authority = "member";
        }

        const participantType = String(body.type ?? "human") as "human" | "agent";
        const name = String(body.name ?? randomName());

        if (authority === "guest") {
          const id = `obs_${randomUUID().slice(0, 8)}`;
          const channel = room.observe();
          const sessionToken = tokens.createSessionToken(id, "guest");

          guests.set(sessionToken, { id, authority: "guest", channel, sessionToken });
          idToSession.set(id, sessionToken);

          const participantList = room.listParticipants().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            authority: p.authority ?? "member",
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sessionToken,
            participantId: id,
            roomName,
            roomId: room.roomId,
            participants: participantList,
            authority: "guest",
          }));
          return;
        }

        // admin or participant — connect as a real participant
        const id = `${participantType}_${randomUUID().slice(0, 8)}`;
        const channel = await room.connect(id, name, { type: participantType, authority });
        const sessionToken = tokens.createSessionToken(id, authority);

        participants.set(sessionToken, { id, name, authority, channel, sessionToken });
        idToSession.set(id, sessionToken);
        touchParticipant(id);
        presenceStatus.set(id, "online");

        const participantList = room.listParticipants().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          authority: p.authority ?? "member",
        }));

        log(`${name} joined (${authority})`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessionToken,
          participantId: id,
          roomName,
          roomId: room.roomId,
          participants: participantList,
          authority,
        }));
        return;
      }

      // ── All remaining POST endpoints require a session token ────────────

      const sessionToken = extractSessionToken(req, url, body) ?? "";
      const session = getSession(sessionToken);
      // Any authenticated HTTP request counts as proof of life.
      if (session && session.kind === "participant") touchParticipant(session.id);

      // ── POST /message ───────────────────────────────────────────────────
      if (url.pathname === "/message") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (sessionToken) {
          const msgCheck = messageLimiter.check(sessionToken);
          if (!msgCheck.allowed) return rateLimitError(res, msgCheck.retryAfter!);
        }
        if (!can(session.authority, "send_message")) return jsonError(res, 403, "Guests cannot send messages");
        const content = String(body.content ?? "");
        const replyTo = body.replyTo ? String(body.replyTo) : undefined;
        if (!content) return jsonError(res, 400, "Empty message");
        if (content.length > 50_000) return jsonError(res, 400, "Message too long (max 50000 chars)");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        let rawAttachments: Attachment[] | undefined;
        if (Array.isArray(body.attachments) && body.attachments.length > 0) {
          const parsed = AttachmentSchema.array().safeParse(body.attachments);
          if (!parsed.success) return jsonError(res, 400, `Invalid attachments: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
          rawAttachments = parsed.data;
        }

        // Resolve whisper recipients (display names → participant IDs).
        let recipientIds: string[] | undefined;
        if (Array.isArray(body.recipients) && body.recipients.length > 0) {
          recipientIds = [];
          const allParticipants = room.listParticipants();
          for (const name of body.recipients as string[]) {
            const matches = allParticipants.filter((pp) => pp.name === name);
            if (matches.length === 0) return jsonError(res, 400, `Unknown participant "${name}"`);
            if (matches.length > 1) return jsonError(res, 400, `Ambiguous participant name "${name}"`);
            recipientIds.push(matches[0].id);
          }
        }

        const msg = await p.channel.sendMessage(content, replyTo, undefined, rawAttachments, recipientIds);

        // Emit WhisperNotifiedEvent to all non-participants so they see [A → B].
        if (recipientIds && recipientIds.length > 0) {
          const recipientNames = recipientIds
            .map((id) => room.listParticipants().find((pp) => pp.id === id)?.name ?? id);
          const whisperNotified = createEvent<WhisperNotifiedEvent>({
            type: "WhisperNotified",
            category: "ACTIVITY",
            room_id: room.roomId,
            participant_id: p.id,
            sender_id: p.id,
            sender_name: p.name,
            recipient_ids: recipientIds,
            recipient_names: recipientNames,
          });
          // Direct write — intentionally bypasses enrichAndSend (no enrichment
          // needed, not persisted; if enrichAndSend gains per-event auth checks
          // later, revisit this path).
          for (const [participantId, sseRes] of sseConnections) {
            if (!recipientIds.includes(participantId) && participantId !== p.id) {
              sseRes.write(`data: ${JSON.stringify(whisperNotified)}\n\n`);
            }
          }
        }

        jsonOk(res, { messageId: msg.id });
        return;
      }

      // ── POST /event ─────────────────────────────────────────────────────
      if (url.pathname === "/event") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (!can(session.authority, "send_message")) return jsonError(res, 403, "Guests cannot emit events");
        const event = body.event as RoomEvent | undefined;
        if (!event) return jsonError(res, 400, "Missing event");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.emit(event);
        jsonOk(res);
        return;
      }

      // ── POST /metrics ───────────────────────────────────────────────────
      //
      // Agent-runtime heartbeat with token + context size from claude's
      // local jsonl. Broadcast as an ActivityEvent so the room TUI can
      // show `bf · 87k ctx` next to each agent and roll up totals.
      //
      // Body: {
      //   input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      //   last_ctx_tokens, model
      // }
      if (url.pathname === "/metrics") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");
        const detail = {
          input_tokens: Number(body.input_tokens) || 0,
          output_tokens: Number(body.output_tokens) || 0,
          cache_read_tokens: Number(body.cache_read_tokens) || 0,
          cache_create_tokens: Number(body.cache_create_tokens) || 0,
          last_ctx_tokens: Number(body.last_ctx_tokens) || 0,
          model: typeof body.model === "string" ? body.model : "",
          participant_name: p.name,
        };
        await p.channel.emit(createEvent<ActivityEvent>({
          type: "Activity",
          category: "ACTIVITY",
          room_id: room.roomId,
          participant_id: p.id,
          action: "metrics",
          detail,
        }));
        jsonOk(res);
        return;
      }

      // ── POST /activity ──────────────────────────────────────────────────
      //
      // Agent-runtime heartbeat that surfaces what claude is actually doing
      // (e.g. "Sautéed for 12s", "Compacting conversation… 23%") so the room
      // TUI can render real activity next to the participant glyph instead of
      // a static green dot. Body: { label: string|null }. Null clears.
      //
      // Broadcasts an ActivityEvent with action="status_label" so other
      // participants' channels see the update. The agent's own channel skips
      // it (no self-echo needed).
      if (url.pathname === "/activity") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");
        const label = body.label === null || body.label === undefined
          ? null
          : String(body.label).slice(0, 120);
        await p.channel.emit(createEvent<ActivityEvent>({
          type: "Activity",
          category: "ACTIVITY",
          room_id: room.roomId,
          participant_id: p.id,
          action: "status_label",
          detail: { label, participant_name: p.name },
        }));
        jsonOk(res);
        return;
      }

      // ── POST /set-mode ──────────────────────────────────────────────────
      if (url.pathname === "/set-mode") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const targetId = body.participantId ? String(body.participantId) : session.id;
        const mode = String(body.mode ?? "");
        if (!mode) return jsonError(res, 400, "Missing mode");

        // Setting someone else's mode requires admin or product_owner
        if (targetId !== session.id && !can(session.authority, "set_mode_for")) {
          return jsonError(res, 403, "Only admins and product owners can change other participants' modes");
        }

        // Emit mode_changed activity event
        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.emit(createEvent<ActivityEvent>({
          type: "Activity",
          category: "ACTIVITY",
          room_id: room.roomId,
          participant_id: targetId,
          action: "mode_changed",
          detail: { mode },
        }));

        jsonOk(res);
        return;
      }

      // ── POST /set-authority ──────────────────────────────────────────────
      if (url.pathname === "/set-authority") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (!can(session.authority, "mute")) {
          return jsonError(res, 403, "Only admins and product owners can change authority");
        }
        const targetId = String(body.participantId ?? "");
        const newAuthority = String(body.authority ?? "") as AuthorityLevel;
        if (!targetId) return jsonError(res, 400, "Missing participantId");
        if (!["admin", "product_owner", "member", "guest"].includes(newAuthority)) {
          return jsonError(res, 400, "Invalid authority. Must be admin, product_owner, member, or guest.");
        }
        if (targetId === session.id) return jsonError(res, 400, "Cannot change own authority");

        // product_owner can only set member/guest, and cannot touch admins or other product_owners
        if (session.authority === "product_owner") {
          if (!["member", "guest"].includes(newAuthority)) {
            return jsonError(res, 403, "Product owners can only set member or guest authority");
          }
        }

        // Update all three places: ConnectedParticipant, TokenManager session, Room participant
        const targetSession = idToSession.get(targetId);
        if (!targetSession) return jsonError(res, 404, "Participant not found");
        const target = participants.get(targetSession);
        if (!target) return jsonError(res, 404, "Participant not found");

        // product_owner cannot touch admins or other product_owners
        if (session.authority === "product_owner") {
          const currentAuthority = target.authority ?? "member";
          if (currentAuthority === "admin" || currentAuthority === "product_owner") {
            return jsonError(res, 403, "Cannot change authority of admins or product owners");
          }
        }

        target.authority = newAuthority;
        tokens.updateSessionAuthority(targetSession, newAuthority);
        room.setParticipantAuthority(targetId, newAuthority);

        // Emit AuthorityChanged event
        const adminP = participants.get(sessionToken);
        const targetParticipant = room.listParticipants().find(p => p.id === targetId);
        if (adminP && targetParticipant) {
          await adminP.channel.emit(createEvent<AuthorityChangedEvent>({
            type: "AuthorityChanged",
            category: "PRESENCE",
            room_id: room.roomId,
            participant_id: targetId,
            participant: targetParticipant,
            new_authority: newAuthority,
            changed_by: adminP.name,
          }));
        }

        log(`${target.name} authority → ${newAuthority}`);
        jsonOk(res);
        return;
      }

      // ── POST /ping ──────────────────────────────────────────────────────
      if (url.pathname === "/ping") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (!can(session.authority, "ping")) return jsonError(res, 403, "Guests cannot ping");
        const targetId = String(body.participantId ?? "");
        if (!targetId) return jsonError(res, 400, "Missing participantId");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.ping(targetId);
        jsonOk(res);
        return;
      }

      // ── POST /kick ──────────────────────────────────────────────────────
      if (url.pathname === "/kick") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (!can(session.authority, "kick")) return jsonError(res, 403, "Only admins can kick");
        const targetId = String(body.participantId ?? "");
        if (!targetId) return jsonError(res, 400, "Missing participantId");

        // Find and disconnect the target
        const targetSession = idToSession.get(targetId);
        if (targetSession) {
          const targetParticipant = participants.get(targetSession);
          const targetGuest = guests.get(targetSession);
          const target = targetParticipant ?? targetGuest;
          if (target) {
            // Emit ParticipantKicked before disconnect so all participants see it
            const adminP = participants.get(sessionToken);
            const roomParticipant = room.listParticipants().find(p => p.id === targetId);
            if (adminP && roomParticipant) {
              await adminP.channel.emit(createEvent<ParticipantKickedEvent>({
                type: "ParticipantKicked",
                category: "PRESENCE",
                room_id: room.roomId,
                participant_id: targetId,
                participant: roomParticipant,
                kicked_by: adminP.name,
              }));
            }
            // Companion StatusChangedEvent for participants only
            if (targetParticipant) {
              const prevStatus = presenceStatus.get(targetId) ?? "online";
              if (prevStatus !== "offline") {
                broadcastStatusChange(targetId, targetParticipant.name, "offline", prevStatus, "kicked");
              }
              lastSeenAt.delete(targetId);
              presenceStatus.delete(targetId);
            }
            // Silent disconnect — the kicked event replaces ParticipantLeft
            await target.channel.disconnect(true);
            participants.delete(targetSession);
            guests.delete(targetSession);
            idToSession.delete(targetId);
            tokens.revokeSessionToken(targetSession);
            // Close SSE connection
            const sse = sseConnections.get(targetId);
            if (sse) {
              sse.end();
              sseConnections.delete(targetId);
            }
            log(`kicked ${targetId}`);
          }
        }

        jsonOk(res);
        return;
      }

      // ── POST /clear ──────────────────────────────────────────────────────
      if (url.pathname === "/clear") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (!can(session.authority, "clear_history")) return jsonError(res, 403, "Only admins can clear");

        // Wipe storage and room-scoped attachments
        await storage.clearRoom(room.roomId);
        for (const [id, att] of attachmentStore) {
          if (att.roomId === room.roomId) {
            attachmentStore.delete(id);
            attachmentStoreBytes -= att.size;
          }
        }

        // Broadcast RoomCleared to all connected clients via SSE
        const adminP = participants.get(sessionToken);
        const clearEvent = createEvent<RoomClearedEvent>({
          type: "RoomCleared",
          category: "ACTIVITY",
          room_id: room.roomId,
          participant_id: session.id,
          cleared_by: adminP?.name ?? "admin",
        });
        for (const [, sseRes] of sseConnections) {
          sseRes.write(`data: ${JSON.stringify(clearEvent)}\n\n`);
        }

        log(`room cleared by ${adminP?.name ?? session.id}`);
        jsonOk(res);
        return;
      }

      // ── POST /share ─────────────────────────────────────────────────────
      if (url.pathname === "/share") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (sessionToken) {
          const shareCheck = shareLimiter.check(sessionToken);
          if (!shareCheck.allowed) return rateLimitError(res, shareCheck.retryAfter!);
        }
        if (!can(session.authority, "create_share_link")) return jsonError(res, 403, "Guests cannot create share links");

        const targetAuthority = (body.authority as AuthorityLevel) ?? undefined;

        const links: Record<string, string> = {};

        if (targetAuthority) {
          // Generate a specific link
          const token = tokens.generateShareToken(session.authority, targetAuthority);
          if (!token) return jsonError(res, 403, `Cannot generate ${targetAuthority} link`);
          links[targetAuthority] = buildShareUrl(publicUrl, token);
        } else {
          // Generate all links the caller can create
          const tiers: AuthorityLevel[] = ["admin", "product_owner", "member", "guest"];
          for (const tier of tiers) {
            const token = tokens.generateShareToken(session.authority, tier);
            if (token) links[tier] = buildShareUrl(publicUrl, token);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ links }));
        return;
      }

      // ── POST /tunnel ────────────────────────────────────────────────────
      if (url.pathname === "/tunnel") {
        if (!session || !can(session.authority, "start_tunnel")) return jsonError(res, 403, "Admin only");

        if (tunnelProcess) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: publicUrl, alreadyRunning: true }));
          return;
        }

        try {
          tunnelProcess = await startTunnel(port);
          if (!tunnelProcess) {
            return jsonError(res, 500, "Could not start cloudflared — is it installed?");
          }
          const tunnelUrl = await waitForTunnelUrl(tunnelProcess);
          if (!tunnelUrl) {
            tunnelProcess.kill(); tunnelProcess = null;
            return jsonError(res, 504, "Tunnel started but timed out waiting for URL");
          }
          publicUrl = tunnelUrl;
          addCorsOrigin(tunnelUrl);
          saveRoomSession({ roomName, serverUrl, publicUrl, adminToken, memberToken, pid: process.pid });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: tunnelUrl, alreadyRunning: false }));
        } catch {
          return jsonError(res, 500, "Failed to start tunnel");
        }
        return;
      }

      // ── POST /rotate-token ──────────────────────────────────────────────
      if (url.pathname === "/rotate-token") {
        if (!session || !sessionToken) return jsonError(res, 401, "Invalid session token");
        const result = tokens.rotateSessionToken(sessionToken);
        if (!result) return jsonError(res, 401, "Token expired or invalid");

        // Move participant/guest entry to new token
        const p = participants.get(sessionToken);
        if (p) {
          participants.delete(sessionToken);
          p.sessionToken = result.newToken;
          participants.set(result.newToken, p);
          idToSession.set(p.id, result.newToken);
        }
        const g = guests.get(sessionToken);
        if (g) {
          guests.delete(sessionToken);
          g.sessionToken = result.newToken;
          guests.set(result.newToken, g);
          idToSession.set(g.id, result.newToken);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionToken: result.newToken }));
        return;
      }

      // ── POST /disconnect ────────────────────────────────────────────────
      if (url.pathname === "/disconnect") {
        // Accept Authorization header or body.token
        const targetToken = extractSessionToken(req, url, body) ?? "";

        if (targetToken) {
          const p = participants.get(targetToken);
          if (p) {
            const prevStatus = presenceStatus.get(p.id) ?? "online";
            if (prevStatus !== "offline") {
              broadcastStatusChange(p.id, p.name, "offline", prevStatus, "left");
            }
            await p.channel.disconnect();
            participants.delete(targetToken);
            idToSession.delete(p.id);
            tokens.revokeSessionToken(targetToken);
            lastSeenAt.delete(p.id);
            presenceStatus.delete(p.id);
            const sse = sseConnections.get(p.id);
            if (sse) { sse.end(); sseConnections.delete(p.id); }
            log(`${p.name} disconnected`);
          }

          const g = guests.get(targetToken);
          if (g) {
            await g.channel.disconnect();
            guests.delete(targetToken);
            idToSession.delete(g.id);
            tokens.revokeSessionToken(targetToken);
            const sse = sseConnections.get(g.id);
            if (sse) { sse.end(); sseConnections.delete(g.id); }
          }
        }

        jsonOk(res);
        return;
      }
    }

    res.writeHead(404).end("Not found");
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Another apiary instance may be running.`);
      console.error(`  Kill it:   lsof -ti :${port} | xargs kill`);
      console.error(`  Or use:    apiary --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, options.expose ? "0.0.0.0" : "127.0.0.1", () => resolve());
  });

  // Prune expired tokens every 5 minutes
  const pruneInterval = setInterval(() => tokens.pruneExpired(), 5 * 60 * 1000);
  pruneInterval.unref();

  // After this long offline, garbage-collect all per-participant state.
  // Without this, lastSeenAt / presenceStatus / participants / idToSession /
  // sseConnections retain entries for crashed clients forever.
  const OFFLINE_GC_MS = 24 * 60 * 60 * 1000; // 24h

  // Periodic presence checker — runs every 30s
  const presenceInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionToken, p] of participants) {
      const last = lastSeenAt.get(p.id) ?? now;
      const elapsed = now - last;
      const current = presenceStatus.get(p.id) ?? "online";
      if (current === "online" && elapsed > UNRESPONSIVE_AFTER_MS) {
        presenceStatus.set(p.id, "unresponsive");
        broadcastStatusChange(p.id, p.name, "unresponsive", "online", "ping_timeout");
        log(`${p.name} unresponsive`);
      } else if (current === "unresponsive" && elapsed > OFFLINE_AFTER_MS) {
        presenceStatus.set(p.id, "offline");
        broadcastStatusChange(p.id, p.name, "offline", "unresponsive", "ping_timeout");
        log(`${p.name} offline (timeout)`);
      } else if (current === "offline" && elapsed > OFFLINE_GC_MS) {
        // Long-offline participant — purge all state. They can rejoin fresh.
        participants.delete(sessionToken);
        idToSession.delete(p.id);
        tokens.revokeSessionToken(sessionToken);
        const sse = sseConnections.get(p.id);
        if (sse) { try { sse.end(); } catch { /* socket already dead */ } sseConnections.delete(p.id); }
        lastSeenAt.delete(p.id);
        presenceStatus.delete(p.id);
        log(`${p.name} purged after ${Math.round(elapsed / 60_000)}min offline`);
      }
    }
  }, PRESENCE_CHECK_INTERVAL_MS);
  presenceInterval.unref();

  // Start tunnel if --share
  if (options.share) {
    tunnelProcess = await startTunnel(port);
    if (tunnelProcess) {
      const tunnelUrl = await waitForTunnelUrl(tunnelProcess);
      if (tunnelUrl) {
        publicUrl = tunnelUrl;
        addCorsOrigin(tunnelUrl);
      }
    }
  }

  // Generate share tokens on boot
  const adminToken = tokens.generateShareToken("admin", "admin")!;
  const memberToken = tokens.generateShareToken("admin", "member")!;

  // Persist room session for `apiary ps`
  saveRoomSession({ roomName, serverUrl, publicUrl, adminToken, memberToken, pid: process.pid });

  function obfuscate(token: string): string {
    if (token.length <= 8) return "****";
    return token.slice(0, 4) + "..." + token.slice(-4);
  }

  if (options.headless) {
    process.stdout.write(JSON.stringify({ serverUrl, publicUrl, roomName, adminToken, memberToken, savePath }) + "\n");
    process.stderr.write("Warning: raw tokens in stdout — do not share this output.\n");
  } else if (!options.quiet) {
    let version = process.env.npm_package_version ?? "";
    if (!version) {
      try {
        const require = createRequire(import.meta.url);
        const pkg = require("../../package.json");
        version = pkg.version ?? "unknown";
      } catch {
        version = "unknown";
      }
    }
    const adminUrlObfuscated = buildShareUrl(publicUrl, obfuscate(adminToken));
    const joinUrlObfuscated = buildShareUrl(publicUrl, obfuscate(memberToken));

    // Set terminal tab title — hive emoji stable per room.
    process.stdout.write(`\x1b]0;${roomEmoji(roomName)} apiary · ${roomName}\x07`);

    const Y = "\x1b[33m";
    const C = "\x1b[36m";
    const D = "\x1b[2m";
    const B = "\x1b[1m";
    const R = "\x1b[0m";

    console.log(`
  ${Y}${B}apiary${R} ${D}v${version}${R}

  ${D}Room:${R}    ${Y}${roomName}${R}
  ${D}Server:${R}  ${C}${serverUrl}${R}${publicUrl !== serverUrl ? `\n  ${D}Tunnel:${R}  ${C}${publicUrl}${R}` : ""}
  ${D}Saving:${R}  ${D}${savePath}${R}

  ${D}Share:${R}   ${Y}${joinUrlObfuscated}${R}
  ${D}Admin:${R}   ${Y}${adminUrlObfuscated}${R}

  ${D}Join:${R}   ${C}apiary join${R} ${D}<url>${R}
  ${D}Agent:${R}  ${C}apiary claude${R} ${D}<name>${R}  ${D}→ tell it the URL, it joins${R}
`);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async () => {
    log("shutting down...");
    clearInterval(presenceInterval);
    unwatchFile(rulesFilePath, onRulesFileChange);
    clearRoomSession(roomName);
    // Delete auto-saved room state — room is closed, next open starts fresh.
    // Explicit --save/--load files are kept (user opted into persistence).
    if (!options.save && !options.load) {
      try { rmSync(savePath); } catch { /* ok */ }
    }
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    for (const [id, sse] of sseConnections) { sse.end(); sseConnections.delete(id); }
    for (const p of participants.values()) { await p.channel.disconnect().catch(() => {}); }
    for (const g of guests.values()) { await g.channel.disconnect().catch(() => {}); }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Last-ditch tunnel reaper — runs synchronously on any process exit
  // (including process.exit() and natural termination), but NOT on SIGKILL.
  // Without this, an unexpected crash leaves cloudflared running indefinitely,
  // pinning the parent's port and blocking restart.
  const reapTunnel = () => {
    if (tunnelProcess && !tunnelProcess.killed) {
      try { tunnelProcess.kill("SIGTERM"); } catch { /* already dead */ }
    }
  };
  process.on("exit", reapTunnel);
  process.on("uncaughtException", (err) => {
    log(`fatal: uncaughtException — ${err.message}`);
    reapTunnel();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`fatal: unhandledRejection — ${reason instanceof Error ? reason.message : String(reason)}`);
    reapTunnel();
    process.exit(1);
  });

  return { serverUrl, publicUrl, roomName, adminToken, memberToken };
}

// ── Server log ────────────────────────────────────────────────────────────────

function logServer(message: string): void {
  console.log(`  [${formatTimestamp(new Date())}] ${message}`);
}

// ── Cloudflared tunnel ───────────────────────────────────────────────────────

function cloudflaredAvailable(): boolean {
  try {
    execFileSync("which", ["cloudflared"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function startTunnel(port: number): Promise<ChildProcess | null> {
  if (!cloudflaredAvailable()) {
    console.error("  --share requires cloudflared. Install: brew install cloudflared");
    return null;
  }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.on("error", () => {
    // cloudflared failed to start
  });

  return child;
}

function waitForTunnelUrl(child: ChildProcess, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    });

    child.on("exit", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
    });
  });
}
