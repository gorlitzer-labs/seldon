/**
 * Re-join a room whose session was lost.
 *
 * An agent holds one session token per room. Two things kill it while the
 * agent keeps running:
 *
 *   1. The room server restarts. Its session tokens live in memory, so every
 *      call answers 401 "Invalid session token" and the event stream never
 *      comes back — retrying with the same token can never work.
 *   2. The URL the agent joined with dies (a trycloudflare tunnel expires)
 *      while the server is still up on 127.0.0.1. Every call fails with
 *      "fetch failed", and the agent's seat sits in the room as a ghost.
 *
 * The rejoiner keeps what joining took (share token, name, type) and, on a 401
 * from any call or the event stream, joins again under the SAME name — the
 * server replaces the old seat rather than adding one (seatsToEvict) — then
 * swaps the new token into the data source, the SSE connection and the
 * JoinResult. The failed call is retried once by the caller.
 *
 * For a dead URL it looks at the room's local session file
 * (~/.apiary/sessions/room_<name>.json) and, if that names a 127.0.0.1 or
 * localhost address that answers, moves there. No other host is ever tried.
 *
 * A room server that restarted also mints new share tokens. If the agent had
 * joined with one of the room's own tokens recorded in that local file, the
 * rejoiner may use the token of the SAME tier the file now holds — the agent
 * already had that access, so this never raises it. Any other share token that
 * is rejected (403 "Invalid share token") is final: the room really changed,
 * and the agent is told to get a new link instead of being left to loop.
 *
 * Loops are bounded three ways: retries back off (and fail fast during a
 * cooldown); a seat taken over again within 30 s of re-joining is left to the
 * other session, so two processes with one name cannot evict each other
 * forever; and an agent an admin kicked is never re-joined.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RoomConnectionError, type SessionRecovery } from "../agent/remote-room-data-source.js";
import type { RemoteRoomDataSource } from "../agent/remote-room-data-source.js";
import type { EngagementMode } from "../agent/engagement.js";
import type { Participant } from "../core/types.js";

/** What joining took, kept so the room can be joined again unattended. */
export interface RejoinInfo {
  /** The share URL join_room was given. */
  joinUrl: string;
  /** Share token from that URL (absent for a token-less join). */
  shareToken?: string;
  /** Name the agent joined under — re-joining with it replaces the old seat. */
  name: string;
  type: "agent";
  /** The room's name on the server (the agent's alias may differ). */
  serverRoomName: string;
  /**
   * Set when the share token was one of the room's own persisted tokens in the
   * local session file: the tier it was. Lets a re-join after a server restart
   * use the same-tier token the file now holds.
   */
  localTier?: "admin" | "member";
}

/** The parts of a JoinResult the rejoiner reads and rewrites. */
export interface RejoinableRoom {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
  rejoin: RejoinInfo;
  /** Set when the stream reported this agent kicked: never re-join. */
  removedBy?: string;
}

/** The fields of ~/.apiary/sessions/room_<name>.json the rejoiner uses. */
export interface LocalRoomSession {
  serverUrl?: string;
  publicUrl?: string;
  adminToken?: string;
  memberToken?: string;
}

/** Read the local session file of a room hosted on this machine, if any. */
export function readLocalRoomSession(roomName: string): LocalRoomSession | null {
  // The name comes from the server: keep it to a plain file name.
  if (!/^[A-Za-z0-9._-]+$/.test(roomName) || roomName.includes("..")) return null;
  const path = join(homedir(), ".apiary", "sessions", `room_${roomName}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      serverUrl: str(data.serverUrl),
      publicUrl: str(data.publicUrl),
      adminToken: str(data.adminToken),
      memberToken: str(data.memberToken),
    };
  } catch {
    return null;
  }
}

/** Only these hosts are ever used as a fallback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/** Which of the room's own tokens (if any) the agent joined with. */
export function localTierOf(shareToken: string | undefined, session: LocalRoomSession | null): "admin" | "member" | undefined {
  if (!shareToken || !session) return undefined;
  if (session.adminToken === shareToken) return "admin";
  if (session.memberToken === shareToken) return "member";
  return undefined;
}

export interface RejoinDeps {
  sseMux: { updateConnection(roomId: string, serverUrl: string, sessionToken: string): void };
  processor: {
    participantId: string;
    setRoomParticipantId(roomId: string, participantId: string): void;
    getModeForRoom(roomId: string): EngagementMode;
  };
  /** One line per reconnect, to stderr in `apiary mcp`. */
  log?: (line: string) => void;
  /** Told once when a room is lost for good. */
  onLost?: (room: RejoinableRoom, error: RoomConnectionError) => void;
  /** Told after each successful automatic re-join (the token may have changed). */
  onRejoined?: (room: RejoinableRoom) => void;
  fetch?: typeof fetch;
  readRoomSession?: (roomName: string) => LocalRoomSession | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Waits between attempts inside one re-join. Default [500, 1500]. */
  retryDelaysMs?: number[];
  /** Longest fail-fast cooldown after failed re-joins. Default 30 s. */
  maxCooldownMs?: number;
  /** A seat lost again this soon after re-joining is left alone. Default 30 s. */
  replacedWindowMs?: number;
  /** Least time between local-URL probes on network errors. Default 5 s. */
  probeIntervalMs?: number;
}

type Attempt =
  | { ok: true; url: string; shareToken?: string; data: Record<string, unknown> }
  | { ok: false; kind: "share-rejected" | "transient" | "unreachable" | "wrong-room"; error: string };

export class RoomRejoiner implements SessionRecovery {
  private inflight: Promise<void> | null = null;
  private lost: RoomConnectionError | null = null;
  private failures = 0;
  private cooldownUntil = 0;
  private lastRejoinAt = Number.NEGATIVE_INFINITY;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readSession: (roomName: string) => LocalRoomSession | null;

  constructor(private room: RejoinableRoom, private deps: RejoinDeps) {
    this.fetchFn = deps.fetch ?? ((...args) => fetch(...args));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.readSession = deps.readRoomSession ?? readLocalRoomSession;
  }

  /** Why the room is lost for good, if it is. */
  get lostError(): RoomConnectionError | null {
    return this.lost;
  }

  // ── SessionRecovery (RemoteRoomDataSource) ─────────────────────────────

  async sessionInvalid(usedToken?: string): Promise<void> {
    // Another caller already re-joined while this request was in flight.
    if (usedToken !== undefined && usedToken !== this.room.sessionToken) return;
    await this.rejoin("session token rejected (401)");
  }

  async unreachable(): Promise<boolean> {
    if (this.lost || this.room.removedBy) return false;
    const now = this.now();
    if (now - this.lastProbeAt < (this.deps.probeIntervalMs ?? 5000)) return false;
    this.lastProbeAt = now;

    const local = this.readSession(this.room.rejoin.serverRoomName)?.serverUrl;
    if (!local || !isLoopbackUrl(local) || sameOrigin(local, this.room.serverUrl)) return false;
    const base = local.replace(/\/$/, "");

    // Same server on another address? The current session may still be valid
    // there, which keeps the seat as it is.
    let res: Response;
    try {
      res = await this.fetchFn(`${base}/participants`, {
        headers: { Authorization: `Bearer ${this.room.sessionToken}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return false;
    }
    await res.body?.cancel().catch(() => {});
    if (res.ok) {
      const from = this.room.serverUrl;
      this.swapSession(base, this.room.sessionToken);
      this.log(`room "${this.room.roomName}": ${from} unreachable, moved to ${base} (same session)`);
      return true;
    }
    if (res.status === 401) {
      try {
        await this.rejoin(`${this.room.serverUrl} unreachable`);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ── SseRecoveryHandler (per room) ──────────────────────────────────────

  async authRejected(status: number, usedToken?: string): Promise<boolean> {
    if (usedToken !== undefined && usedToken !== this.room.sessionToken) return true;
    try {
      await this.rejoin(`event stream rejected (${status})`);
      return true;
    } catch (err) {
      if (err instanceof RoomConnectionError && err.permanent) throw err;
      return false;
    }
  }

  // ── Re-join ────────────────────────────────────────────────────────────

  /**
   * Join the room again and swap the new session in everywhere. Concurrent
   * callers share one attempt. Throws RoomConnectionError: `permanent` when
   * retrying cannot help, otherwise after bounded retries.
   */
  rejoin(reason: string): Promise<void> {
    if (this.lost) return Promise.reject(this.lost);
    const roomLabel = `"${this.room.roomName}"`;
    if (this.room.removedBy) return Promise.reject(this.removed());
    if (this.inflight) return this.inflight;

    const now = this.now();
    if (now - this.lastRejoinAt < (this.deps.replacedWindowMs ?? 30_000)) {
      return Promise.reject(this.loseFor(
        `Your seat in room ${roomLabel} was taken over again right after apiary re-joined it — another ` +
        `session is probably using the name "${this.room.rejoin.name}". Not re-joining automatically, so the ` +
        `two do not keep evicting each other. Call join_room to take the seat back.`,
      ));
    }
    if (now < this.cooldownUntil) {
      const secs = Math.ceil((this.cooldownUntil - now) / 1000);
      return Promise.reject(new RoomConnectionError(
        `Lost the session in room ${roomLabel} and the last re-join failed; apiary retries in ${secs}s. ` +
        `If this persists, call join_room again with the room's share URL.`,
        false,
      ));
    }

    this.inflight = this.runRejoin(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runRejoin(reason: string): Promise<void> {
    const roomLabel = `"${this.room.roomName}"`;
    this.log(`room ${roomLabel}: ${reason}; re-joining as "${this.room.rejoin.name}"`);
    const delays = [0, ...(this.deps.retryDelaysMs ?? [500, 1500])];
    let lastError = "";

    for (const delay of delays) {
      if (delay > 0) await this.sleep(delay);
      if (this.room.removedBy) break;
      const outcome = await this.attemptOnce();
      if (outcome.permanent) {
        throw this.loseFor(
          `Room ${roomLabel} no longer accepts the share link this agent joined with (${outcome.error}). ` +
          `The room was recreated or the link revoked — ask for a new share URL and call join_room with it.`,
        );
      }
      if (outcome.done) {
        this.failures = 0;
        this.cooldownUntil = 0;
        this.lastRejoinAt = this.now();
        return;
      }
      lastError = outcome.error;
    }

    if (this.room.removedBy) throw this.removed();
    this.failures += 1;
    const cooldown = Math.min(1000 * 2 ** (this.failures - 1), this.deps.maxCooldownMs ?? 30_000);
    this.cooldownUntil = this.now() + cooldown;
    this.log(`room ${roomLabel}: re-join failed (${lastError}); next try in ${Math.ceil(cooldown / 1000)}s`);
    throw new RoomConnectionError(
      `Lost the session in room ${roomLabel} (${reason}) and could not re-join yet: ${lastError}. ` +
      `apiary keeps retrying; if this persists, call join_room again with the room's share URL.`,
      false,
    );
  }

  /** One pass over the candidate addresses and tokens. */
  private async attemptOnce(): Promise<{ done: boolean; permanent: boolean; error: string }> {
    const info = this.room.rejoin;
    const candidates: Array<{ url: string; shareToken?: string }> = [
      { url: this.room.serverUrl, shareToken: info.shareToken },
    ];
    const session = this.readSession(info.serverRoomName);
    const local = session?.serverUrl && isLoopbackUrl(session.serverUrl)
      ? session.serverUrl.replace(/\/$/, "")
      : undefined;
    if (local && !sameOrigin(local, this.room.serverUrl)) {
      candidates.push({ url: local, shareToken: info.shareToken });
    }
    // After a restart the room's own tokens are new. Same tier only.
    const fresh = info.localTier === "admin" ? session?.adminToken
      : info.localTier === "member" ? session?.memberToken
      : undefined;
    if (local && fresh && fresh !== info.shareToken) {
      candidates.push({ url: local, shareToken: fresh });
    }

    let shareRejected = "";
    let transient = "";
    let unreachable = "";
    for (const c of candidates) {
      const r = await this.joinAt(c.url, c.shareToken);
      if (r.ok) {
        this.apply(r.url, r.shareToken, r.data);
        return { done: true, permanent: false, error: "" };
      }
      if (r.kind === "share-rejected") shareRejected = r.error;
      else if (r.kind === "unreachable") unreachable ||= r.error;
      else transient ||= r.error;
    }
    if (shareRejected && !transient) return { done: false, permanent: true, error: shareRejected };
    return { done: false, permanent: false, error: transient || unreachable || shareRejected || "no address answered" };
  }

  private async joinAt(url: string, shareToken: string | undefined): Promise<Attempt> {
    const body: Record<string, unknown> = { type: this.room.rejoin.type, name: this.room.rejoin.name };
    if (shareToken) body.token = shareToken;
    let res: Response;
    try {
      res = await this.fetchFn(`${url}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, kind: "unreachable", error: `${url} unreachable (${err instanceof Error ? err.message : String(err)})` };
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 403 && /invalid share token/i.test(text)) {
        return { ok: false, kind: "share-rejected", error: `403 Invalid share token at ${url}` };
      }
      return { ok: false, kind: "transient", error: `${res.status} from ${url}/join${text ? `: ${text}` : ""}` };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (String(data.roomName ?? "") !== this.room.rejoin.serverRoomName || String(data.roomId ?? "") !== this.room.roomId) {
      // Not the room this agent was in. Leave the seat we just took.
      await this.fetchFn(`${url}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(data.sessionToken ?? "")}` },
        body: "{}",
      }).catch(() => {});
      return { ok: false, kind: "wrong-room", error: `${url} serves a different room (${String(data.roomName ?? "?")})` };
    }
    return { ok: true, url, shareToken, data };
  }

  /** Swap the new session into the JoinResult, data source, processor and SSE stream. */
  private apply(url: string, shareToken: string | undefined, data: Record<string, unknown>): void {
    const room = this.room;
    const oldId = room.participantId;
    const token = String(data.sessionToken ?? "");
    const newId = String(data.participantId ?? "");
    const participants = (data.participants as Participant[]) ?? [];

    room.participantId = newId;
    room.authority = String(data.authority ?? room.authority);
    room.participants = participants;
    if (shareToken !== undefined) room.rejoin.shareToken = shareToken;
    room.dataSource.setParticipants(participants);
    room.dataSource.setSelf(newId, room.rejoin.name);

    const { processor } = this.deps;
    processor.setRoomParticipantId(room.roomId, newId);
    if (processor.participantId === oldId) processor.participantId = newId;

    this.swapSession(url, token);
    this.log(`room "${room.roomName}": re-joined as "${room.rejoin.name}" at ${url}`);
    try { this.deps.onRejoined?.(room); } catch { /* a notifier must not break recovery */ }

    // The server starts a new seat in its default mode; tell it the one in use.
    const mode = processor.getModeForRoom(room.roomId);
    if (mode !== "everyone") {
      this.fetchFn(`${url}/set-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode }),
      }).catch(() => {});
    }
  }

  private swapSession(url: string, token: string): void {
    this.room.serverUrl = url;
    this.room.sessionToken = token;
    this.room.dataSource.setSession(url, token);
    this.deps.sseMux.updateConnection(this.room.roomId, url, token);
  }

  private removed(): RoomConnectionError {
    return this.loseFor(
      `You were removed from room "${this.room.roomName}" by ${this.room.removedBy}, so apiary will not ` +
      `re-join it. Call join_room again only if you are invited back.`,
    );
  }

  private loseFor(message: string): RoomConnectionError {
    if (!this.lost) {
      this.lost = new RoomConnectionError(message, true);
      this.log(`room "${this.room.roomName}": giving up — ${message}`);
      try {
        this.deps.onLost?.(this.room, this.lost);
      } catch { /* a notifier must not break recovery */ }
    }
    return this.lost;
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}
