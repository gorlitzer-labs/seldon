/**
 * RemoteRoomDataSource — HTTP-backed RoomDataSource.
 *
 * Implements the RoomDataSource interface by making HTTP calls to a stoop
 * server. Used by the client-side agent runtime when connecting to remote
 * apiary.
 *
 * Participant list is cached locally and updated by the agent runtime
 * when it processes ParticipantJoined/Left events from the SSE stream.
 *
 * The server URL and session token can change under a live source: when the
 * room server restarts, every session token it issued is gone, and when the
 * URL the agent joined with dies (an expired tunnel) the room may still answer
 * on localhost. A `SessionRecovery` (see cli/rejoin.ts) handles both; every
 * request goes through `request()`, which asks it for help once and retries.
 */

import type { RoomEvent } from "../core/events.js";
import type { EventCategory, Message, PaginatedResult, Participant } from "../core/types.js";
import type { RoomDataSource } from "./room-data-source.js";

/**
 * The room connection is lost and could not be restored automatically.
 *
 * Reads that used to answer "nothing" on any failure let this through, so the
 * agent is told the room is unreachable instead of being shown an empty room.
 * `permanent` means retrying will not help (the share link no longer works,
 * or the agent was removed); the agent has to join again.
 */
export class RoomConnectionError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "RoomConnectionError";
  }
}

/** Restores a lost session. Implemented by the CLI runtime's RoomRejoiner. */
export interface SessionRecovery {
  /**
   * The server answered 401 (the session token is no longer valid). Put a new
   * session in place with `setSession()` and resolve, or throw a
   * RoomConnectionError saying why that was not possible. `usedToken` is the
   * token the rejected request carried: if it is no longer the current one,
   * someone else already re-joined and there is nothing to do.
   */
  sessionInvalid(usedToken?: string): Promise<void>;
  /**
   * A request never reached the server (network error). Resolve true when the
   * source now points at a URL that answers, false otherwise. Never throws.
   */
  unreachable(): Promise<boolean>;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class RemoteRoomDataSource implements RoomDataSource {
  private _participants: Participant[] = [];
  private _selfId = "";
  private _selfName = "";
  private _recovery: SessionRecovery | null = null;

  constructor(
    private _serverUrl: string,
    private _sessionToken: string,
    private _roomId: string,
  ) {}

  /** Set own identity for populating outgoing message stubs. */
  setSelf(id: string, name: string): void {
    this._selfId = id;
    this._selfName = name;
  }

  /** Swap in a new server URL and/or session token (after a re-join or URL fallback). */
  setSession(serverUrl: string, sessionToken: string): void {
    this._serverUrl = serverUrl;
    this._sessionToken = sessionToken;
  }

  /** Install the handler that restores a lost session. */
  setRecovery(recovery: SessionRecovery | null): void {
    this._recovery = recovery;
  }

  get roomId(): string {
    return this._roomId;
  }

  get selfId(): string {
    return this._selfId;
  }

  get serverUrl(): string {
    return this._serverUrl;
  }

  get sessionToken(): string {
    return this._sessionToken;
  }

  // ── Participant cache ─────────────────────────────────────────────────────

  /** Set the initial participant list (from join response). */
  setParticipants(participants: Participant[]): void {
    this._participants = [...participants];
  }

  /** Add a participant (on ParticipantJoined event). */
  addParticipant(participant: Participant): void {
    // Remove any existing entry with same ID first
    this._participants = this._participants.filter((p) => p.id !== participant.id);
    this._participants.push(participant);
  }

  /** Remove a participant (on ParticipantLeft event). */
  removeParticipant(participantId: string): void {
    this._participants = this._participants.filter((p) => p.id !== participantId);
  }

  listParticipants(): Participant[] {
    return [...this._participants];
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /**
   * An authenticated request to the room server, with the CURRENT URL and
   * token. On a network error or a 401 it asks the recovery handler once, then
   * retries once with whatever URL and token are in place afterwards.
   *
   * Throws RoomConnectionError when the session was invalid and could not be
   * restored; rethrows a network error that no fallback could route around.
   */
  async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    let usedToken = this._sessionToken;
    const attempt = () => {
      usedToken = this._sessionToken;
      return fetch(`${this._serverUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${usedToken}` },
      });
    };

    let res: Response;
    try {
      res = await attempt();
    } catch (err) {
      if (isAbort(err) || !this._recovery) throw err;
      if (!(await this._recovery.unreachable())) throw err;
      res = await attempt();
    }
    if (res.status === 401 && this._recovery) {
      await res.body?.cancel().catch(() => {});
      await this._recovery.sessionInvalid(usedToken);
      res = await attempt();
    }
    return res;
  }

  // ── HTTP-backed data access ───────────────────────────────────────────────

  async getMessage(id: string): Promise<Message | null> {
    try {
      const res = await this.request(`/message/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { message: Message };
      return data.message;
    } catch (err) {
      if (err instanceof RoomConnectionError) throw err;
      return null;
    }
  }

  async searchMessages(
    query: string,
    limit = 10,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const params = new URLSearchParams({ query, count: String(limit) });
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await this.request(`/search?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<Message>;
    } catch (err) {
      if (err instanceof RoomConnectionError) throw err;
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async getMessages(
    limit = 30,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const params = new URLSearchParams({ count: String(limit) });
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await this.request(`/messages?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<Message>;
    } catch (err) {
      if (err instanceof RoomConnectionError) throw err;
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async getEvents(
    category: EventCategory | null = null,
    limit = 50,
    cursor: string | null = null,
  ): Promise<PaginatedResult<RoomEvent>> {
    const params = new URLSearchParams({ count: String(limit) });
    if (category) params.set("category", category);
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await this.request(`/events/history?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<RoomEvent>;
    } catch (err) {
      if (err instanceof RoomConnectionError) throw err;
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async sendMessage(
    content: string,
    replyToId?: string,
    image?: { url: string; mimeType: string; sizeBytes: number } | null,
    attachments?: import("../core/types.js").Attachment[],
    recipients?: string[],
  ): Promise<Message> {
    const body: Record<string, unknown> = { content };
    if (replyToId) body.replyTo = replyToId;
    if (image) body.image = image;
    if (attachments?.length) body.attachments = attachments;
    if (recipients?.length) body.recipients = recipients;

    const res = await this.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to send message: ${err}`);
    }

    const data = (await res.json()) as { ok: boolean; messageId: string };

    // Return a stub — the full message will arrive via SSE
    return {
      id: data.messageId,
      room_id: this._roomId,
      sender_id: this._selfId,
      sender_name: this._selfName,
      content,
      timestamp: new Date(),
    } as Message;
  }

  async emitEvent(event: RoomEvent): Promise<void> {
    const res = await this.request("/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    });

    if (!res.ok) {
      // Best effort — don't throw for event emission failures
    }
  }
}
