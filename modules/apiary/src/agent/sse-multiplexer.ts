/**
 * SseMultiplexer — merges N SSE connections into one labeled event stream.
 *
 * Each connection is an HTTP fetch to a stoop server's /events endpoint.
 * Events are parsed from the SSE `data:` lines and wrapped as LabeledEvents
 * (same shape as EventMultiplexer output so EventProcessor can consume either).
 *
 * Connections can be added/removed while the multiplexer is running.
 * Each connection has its own AbortController for independent lifecycle.
 *
 * A dropped stream is retried with backoff. Retrying alone never recovers a
 * room server that restarted — its session tokens are gone, so every retry is
 * a 401 — or a URL that died while the room is still up on localhost. Those go
 * to the recovery handler (see cli/rejoin.ts), which re-joins or switches URL
 * and calls `updateConnection()`; each attempt reads the connection's current
 * URL and token, so the next one uses the new session.
 */

import type { RoomEvent } from "../core/events.js";
import type { LabeledEvent } from "./multiplexer.js";

interface SseConnection {
  serverUrl: string;
  sessionToken: string;
  roomName: string;
  roomId: string;
  abortController: AbortController;
  /** Aborts only the current attempt, so a new session takes effect at once. */
  attempt: AbortController | null;
  loopPromise: Promise<void>;
}

/** What the SSE loop asks for when retrying alone cannot help. */
export interface SseRecoveryHandler {
  /**
   * /events answered 401 or 403: the session is gone. Resolve true when a new
   * session is in place (retry now), false to back off and retry later. Throw
   * to stop this connection for good — the error says why. `usedToken` is the
   * token the rejected attempt carried.
   */
  authRejected(roomId: string, status: number, usedToken: string): Promise<boolean>;
  /** /events could not be reached. Resolve true when a different URL now answers. */
  unreachable(roomId: string): Promise<boolean>;
}

export interface SseMultiplexerOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class SseMultiplexer {
  private _queue: LabeledEvent[] = [];
  private _waiters: Array<{ resolve: (value: LabeledEvent) => void }> = [];
  private _connections = new Map<string, SseConnection>();
  private _closed = false;
  private _recovery: SseRecoveryHandler | null = null;
  private readonly _initialBackoff: number;
  private readonly _maxBackoff: number;

  constructor(options: SseMultiplexerOptions = {}) {
    this._initialBackoff = options.initialBackoffMs ?? 1000;
    this._maxBackoff = options.maxBackoffMs ?? 30000;
  }

  /** Install the handler for lost sessions and dead URLs. */
  setRecoveryHandler(handler: SseRecoveryHandler | null): void {
    this._recovery = handler;
  }

  /**
   * Add an SSE connection to a stoop server.
   * Starts streaming events immediately.
   */
  addConnection(serverUrl: string, sessionToken: string, roomName: string, roomId: string): void {
    if (this._connections.has(roomId) || this._closed) return;

    const abortController = new AbortController();
    const conn: SseConnection = {
      serverUrl, sessionToken, roomName, roomId, abortController, attempt: null,
      loopPromise: Promise.resolve(),
    };
    this._connections.set(roomId, conn);
    conn.loopPromise = this._sseLoop(conn);
  }

  /** Is there a live (not stopped) connection for this room? */
  hasConnection(roomId: string): boolean {
    return this._connections.has(roomId);
  }

  /**
   * Point a connection at a new URL and/or session token. The current attempt
   * is dropped so the stream reconnects with the new session straight away.
   */
  updateConnection(roomId: string, serverUrl: string, sessionToken: string): void {
    const conn = this._connections.get(roomId);
    if (!conn) return;
    conn.serverUrl = serverUrl;
    conn.sessionToken = sessionToken;
    conn.attempt?.abort();
  }

  /** Remove a connection by room ID. */
  removeConnection(roomId: string): void {
    const entry = this._connections.get(roomId);
    if (!entry) return;
    entry.abortController.abort();
    this._connections.delete(roomId);
  }

  /** Close all connections and signal the iterator to finish. */
  close(): void {
    this._closed = true;
    for (const [, entry] of this._connections) {
      entry.abortController.abort();
    }
    this._connections.clear();

    // Resolve all pending waiters so the iterator returns done
    for (const waiter of this._waiters) {
      waiter.resolve(null as unknown as LabeledEvent);
    }
    this._waiters = [];
  }

  private async _sseLoop(conn: SseConnection): Promise<void> {
    const { roomId, roomName } = conn;
    const signal = conn.abortController.signal;
    let backoff = this._initialBackoff;

    while (!signal.aborted && !this._closed) {
      // true = something changed (new session / new URL): retry without waiting
      let retryNow = false;
      const attempt = new AbortController();
      conn.attempt = attempt;
      const attemptSignal = AbortSignal.any([signal, attempt.signal]);
      const usedToken = conn.sessionToken;
      try {
        // POST required — Cloudflare Quick Tunnels buffer GET streaming
        // responses and only flush on connection close. POST streams in real-time.
        const res = await fetch(`${conn.serverUrl}/events`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${usedToken}`,
          },
          signal: attemptSignal,
        });

        if ((res.status === 401 || res.status === 403) && this._recovery) {
          await res.body?.cancel().catch(() => {});
          try {
            retryNow = await this._recovery.authRejected(roomId, res.status, usedToken);
          } catch {
            // Permanent: the handler has told the agent why. Stop retrying a
            // session that can never come back.
            if (this._connections.get(roomId) === conn) this._connections.delete(roomId);
            return;
          }
          if (retryNow) backoff = this._initialBackoff;
          throw new Error(`SSE auth rejected: ${res.status}`);
        }

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        // Connected — reset backoff
        backoff = this._initialBackoff;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!attemptSignal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE: split on double newline
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // keep incomplete chunk

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as RoomEvent;
              this._push({ roomId, roomName, event });
            } catch {
              // Malformed event — skip
            }
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        if (attempt.signal.aborted) {
          // updateConnection() swapped the session: reconnect at once.
          retryNow = true;
          backoff = this._initialBackoff;
        } else if (!retryNow && !(err instanceof Error && err.message.startsWith("SSE ")) && this._recovery) {
          // The fetch itself failed (network): maybe the room answers elsewhere.
          try {
            if (await this._recovery.unreachable(roomId)) {
              retryNow = true;
              backoff = this._initialBackoff;
            }
          } catch { /* never fatal */ }
        }
      } finally {
        if (conn.attempt === attempt) conn.attempt = null;
      }

      if (!signal.aborted && !this._closed && !retryNow) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, this._maxBackoff);
      }
    }
  }

  private _push(labeled: LabeledEvent): void {
    if (this._closed) return;
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve(labeled);
    } else {
      this._queue.push(labeled);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<LabeledEvent> {
    return {
      next: (): Promise<IteratorResult<LabeledEvent>> => {
        // Drain buffered events first
        if (this._queue.length > 0) {
          return Promise.resolve({ value: this._queue.shift()!, done: false });
        }

        if (this._closed) {
          return Promise.resolve({ value: undefined as unknown as LabeledEvent, done: true });
        }

        return new Promise<IteratorResult<LabeledEvent>>((resolve) => {
          this._waiters.push({
            resolve: (value) => {
              if (this._closed || value === null) {
                resolve({ value: undefined as unknown as LabeledEvent, done: true });
              } else {
                resolve({ value, done: false });
              }
            },
          });
        });
      },
    };
  }
}
