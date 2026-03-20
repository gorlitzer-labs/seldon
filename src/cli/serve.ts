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
import { createRequire } from "node:module";
import { tmpdir, networkInterfaces } from "node:os";
import { join as pathJoin, resolve, sep } from "node:path";

import { Room } from "../core/room.js";
import { InMemoryStorage, FileBackedStorage } from "../core/storage.js";
import { randomRoomName, randomName } from "../core/names.js";
import { createEvent, type ActivityEvent, type AuthorityChangedEvent, type ParticipantKickedEvent, type RoomEvent } from "../core/events.js";
import type { AuthorityLevel } from "../core/types.js";
import type { Channel } from "../core/channel.js";
import { formatTimestamp } from "../agent/prompts.js";
import { TokenManager, buildShareUrl } from "./auth.js";

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
}

export interface ServeResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
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

function validateSavePath(p: string): string {
  const resolved = resolve(p);
  if (!resolved.endsWith(".json")) throw new Error("Save/load path must end with .json");
  const cwd = process.cwd();
  const tmp = tmpdir();
  if (!resolved.startsWith(cwd + sep) && !resolved.startsWith(tmp + sep))
    throw new Error(`Path must be under ${cwd} or ${tmp}`);
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

  // Create room with persistence (default: tmp folder)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const savePath = options.save ?? options.load ?? pathJoin(tmpdir(), `apiary-${roomName}-${timestamp}.json`);
  let storage;
  if (options.load) {
    try {
      storage = await FileBackedStorage.load(options.load);
      log(`loaded room state from ${options.load}`);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        storage = new FileBackedStorage(options.load);
        log(`no existing file at ${options.load}, starting fresh`);
      } else {
        throw err;
      }
    }
  } else {
    storage = new FileBackedStorage(savePath);
  }
  const room = new Room(roomName, storage);

  // Auth
  const tokens = new TokenManager();

  // Connected participants and guests (by session token for lookup)
  const participants = new Map<string, ConnectedParticipant>();
  const guests = new Map<string, ConnectedGuest>();
  // Reverse lookup: participantId → sessionToken
  const idToSession = new Map<string, string>();

  // Track active SSE connections for cleanup
  const sseConnections = new Map<string, ServerResponse>();

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
    constructor(private _max: number, private _windowMs: number) {}
    check(key: string): { allowed: boolean; retryAfter?: number } {
      const now = Date.now();
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

      // Heartbeat every 30s to keep the connection alive through
      // proxies, firewalls, and OS-level TCP idle timeouts.
      const heartbeat = setInterval(() => {
        res.write(":heartbeat\n\n");
      }, 30_000);

      // Send recent history so the joiner has context
      const history = await room.listEvents(undefined, 50);
      for (const event of [...history.items].reverse()) {
        await enrichAndSend(res, event, room);
      }

      // Live event stream
      const streamEvents = async () => {
        try {
          for await (const event of session.channel) {
            await enrichAndSend(res, event, room);
          }
        } catch {
          // Channel disconnected
        }
      };
      streamEvents();

      // Cleanup on client disconnect
      req.on("close", () => {
        clearInterval(heartbeat);
        sseConnections.delete(session.id);
      });
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // ── GET /events/history ──────────────────────────────────────────────
      if (url.pathname === "/events/history") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const category = url.searchParams.get("category") ?? null;
        const count = clampInt(url.searchParams.get("count"), 50, 1, 200);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.listEvents(category as any, count, cursor);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
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
        } else if (legacyType === "human") {
          authority = "member";
        } else {
          // Default: agent joins as member
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

      // ── POST /message ───────────────────────────────────────────────────
      if (url.pathname === "/message") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (sessionToken) {
          const msgCheck = messageLimiter.check(sessionToken);
          if (!msgCheck.allowed) return rateLimitError(res, msgCheck.retryAfter!);
        }
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot send messages");
        const content = String(body.content ?? "");
        const replyTo = body.replyTo ? String(body.replyTo) : undefined;
        if (!content) return jsonError(res, 400, "Empty message");
        if (content.length > 50_000) return jsonError(res, 400, "Message too long (max 50000 chars)");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        const msg = await p.channel.sendMessage(content, replyTo);
        jsonOk(res, { messageId: msg.id });
        return;
      }

      // ── POST /event ─────────────────────────────────────────────────────
      if (url.pathname === "/event") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot emit events");
        const event = body.event as RoomEvent | undefined;
        if (!event) return jsonError(res, 400, "Missing event");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.emit(event);
        jsonOk(res);
        return;
      }

      // ── POST /set-mode ──────────────────────────────────────────────────
      if (url.pathname === "/set-mode") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const targetId = body.participantId ? String(body.participantId) : session.id;
        const mode = String(body.mode ?? "");
        if (!mode) return jsonError(res, 400, "Missing mode");

        // Setting someone else's mode requires admin
        if (targetId !== session.id && session.authority !== "admin") {
          return jsonError(res, 403, "Only admins can change other participants' modes");
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
        if (session.authority !== "admin") return jsonError(res, 403, "Only admins can change authority");
        const targetId = String(body.participantId ?? "");
        const newAuthority = String(body.authority ?? "") as AuthorityLevel;
        if (!targetId) return jsonError(res, 400, "Missing participantId");
        if (!["admin", "member", "guest"].includes(newAuthority)) {
          return jsonError(res, 400, "Invalid authority. Must be admin, member, or guest.");
        }
        if (targetId === session.id) return jsonError(res, 400, "Cannot change own authority");

        // Update all three places: ConnectedParticipant, TokenManager session, Room participant
        const targetSession = idToSession.get(targetId);
        if (!targetSession) return jsonError(res, 404, "Participant not found");
        const target = participants.get(targetSession);
        if (!target) return jsonError(res, 404, "Participant not found");

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
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot ping");
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
        if (session.authority !== "admin") return jsonError(res, 403, "Only admins can kick");
        const targetId = String(body.participantId ?? "");
        if (!targetId) return jsonError(res, 400, "Missing participantId");

        // Find and disconnect the target
        const targetSession = idToSession.get(targetId);
        if (targetSession) {
          const target = participants.get(targetSession) ?? guests.get(targetSession);
          if (target) {
            // Emit ParticipantKicked before disconnect so all participants see it
            const adminP = participants.get(sessionToken);
            const targetParticipant = room.listParticipants().find(p => p.id === targetId);
            if (adminP && targetParticipant) {
              await adminP.channel.emit(createEvent<ParticipantKickedEvent>({
                type: "ParticipantKicked",
                category: "PRESENCE",
                room_id: room.roomId,
                participant_id: targetId,
                participant: targetParticipant,
                kicked_by: adminP.name,
              }));
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

      // ── POST /share ─────────────────────────────────────────────────────
      if (url.pathname === "/share") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (sessionToken) {
          const shareCheck = shareLimiter.check(sessionToken);
          if (!shareCheck.allowed) return rateLimitError(res, shareCheck.retryAfter!);
        }
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot create share links");

        const targetAuthority = (body.authority as AuthorityLevel) ?? undefined;

        const links: Record<string, string> = {};

        if (targetAuthority) {
          // Generate a specific link
          const token = tokens.generateShareToken(session.authority, targetAuthority);
          if (!token) return jsonError(res, 403, `Cannot generate ${targetAuthority} link`);
          links[targetAuthority] = buildShareUrl(publicUrl, token);
        } else {
          // Generate all links the caller can create
          const tiers: AuthorityLevel[] = ["admin", "member", "guest"];
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
        if (!session || session.authority !== "admin") return jsonError(res, 403, "Admin only");

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
        // Accept Authorization header, body.token, or legacy participantId/agentId
        const token = extractSessionToken(req, url, body) ?? "";
        const legacyId = String(body.participantId ?? body.agentId ?? "");

        let targetToken = token;
        if (!targetToken && legacyId) {
          targetToken = idToSession.get(legacyId) ?? "";
        }

        if (targetToken) {
          const p = participants.get(targetToken);
          if (p) {
            await p.channel.disconnect();
            participants.delete(targetToken);
            idToSession.delete(p.id);
            tokens.revokeSessionToken(targetToken);
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

    // Set terminal tab title
    const hiveEmoji = ["🍯", "🐝", "🏠", "🪺", "🌸"][Math.floor(Math.random() * 5)];
    process.stdout.write(`\x1b]0;${hiveEmoji} apiary · ${roomName}\x07`);

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
