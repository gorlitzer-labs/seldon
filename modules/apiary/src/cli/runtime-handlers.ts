/**
 * Shared MCP-server option builder for the CLI runtime.
 *
 * Both entry points wire the SAME set of local MCP tool handlers against an
 * EventProcessor + SseMultiplexer:
 *   - `setupAgentRuntime` (apiary claude / codex / opencode — tmux/HTTP delivery)
 *   - `runMcpServer`       (apiary mcp — stdio, pull-based)
 *
 * The handlers proxy tool calls (join/leave/set-mode/ping + admin
 * set-mode-for/mute/unmute/kick/promote/demote) to the apiary server over HTTP.
 * Keeping them here stops the two entry points from drifting — which they had:
 * the stdio path was missing admin promote/demote and the room-rules fetch on
 * join. This builder is the single source for both.
 */

import { extractToken } from "./auth.js";
import { can } from "../core/authority.js";
import { RemoteRoomDataSource } from "../agent/remote-room-data-source.js";
import { EventProcessor } from "../agent/event-processor.js";
import { SseMultiplexer } from "../agent/sse-multiplexer.js";
import { buildCatchUpLines } from "../agent/tool-handlers.js";
import {
  waitForAgent,
  describeOutcome,
  type AgentWaitState,
  type WaitTarget,
} from "../agent/wait-for-agent.js";
import { type EngagementMode } from "../agent/engagement.js";
import type { Participant, AuthorityLevel } from "../core/types.js";
import type { RoomEvent } from "../core/events.js";
import type { RuntimeMcpServerOptions, JoinRoomResult } from "../agent/mcp/runtime.js";
import type { RoomConnectionError } from "../agent/remote-room-data-source.js";
import {
  RoomRejoiner,
  localTierOf,
  readLocalRoomSession,
  type RejoinDeps,
  type RejoinInfo,
} from "./rejoin.js";

/**
 * A room the agent has joined, tracked for cache updates + cleanup.
 *
 * `serverUrl`, `sessionToken` and `participantId` change when the room is
 * re-joined (see rejoin.ts): read them from here each time, never copy them.
 */
export interface JoinResult {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
  /** What joining took (share URL and token, name, type), to re-join unattended. */
  rejoin: RejoinInfo;
  /** Restores a lost session; installed on the data source and the SSE stream. */
  rejoiner?: RoomRejoiner;
  /** Set when the event stream reported this agent kicked: it is never re-joined. */
  removedBy?: string;
  /**
   * Server time (ms, from the /join response's Date header) when this agent
   * joined. The stream replays older events on every connect; they are
   * history, never a reason to wake the agent.
   */
  liveSince?: number;
}

/**
 * Keep a joined room's local view in step with one of its events: the
 * participant cache, and whether this agent was kicked (so it is not
 * re-joined behind the admin's back). Both runtimes' event wrappers call it.
 */
export function trackRoomEvent(jr: JoinResult, event: RoomEvent): void {
  if (event.type === "ParticipantJoined") {
    jr.dataSource.addParticipant(event.participant);
  } else if (event.type === "ParticipantLeft") {
    jr.dataSource.removeParticipant(event.participant_id);
  } else if (event.type === "ParticipantKicked") {
    if (event.participant_id === jr.participantId) jr.removedBy = safeName(event.kicked_by);
    jr.dataSource.removeParticipant(event.participant_id);
  }
}

/** The server's clock at response time, from its Date header (ms), or undefined. */
export function serverTimeOf(res: Response): number | undefined {
  const t = Date.parse(res.headers.get("date") ?? "");
  return Number.isNaN(t) ? undefined : t;
}

function safeName(name: string): string {
  return String(name ?? "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 40) || "an admin";
}

export interface RuntimeHandlerContext {
  processor: EventProcessor;
  sseMux: SseMultiplexer;
  /** Mutable — join/leave handlers push and splice as the agent moves rooms. */
  joinResults: JoinResult[];
  agentName: string;
  authority: AuthorityLevel | undefined;
  /** Fired after a successful join (the tmux/HTTP path repaints its UI). */
  onRoomJoined?: () => void | Promise<void>;
  /** Re-join and URL-fallback lines (stderr in `apiary mcp`). Default: silent. */
  log?: (line: string) => void;
  /** Told once when a room is lost for good and will not be re-joined. */
  onRoomLost?: (jr: JoinResult, error: RoomConnectionError) => void;
  /** After every successful join and automatic re-join (room memory records it). */
  onJoined?: (jr: JoinResult) => void;
  /** After leave_room (room memory forgets it). */
  onLeft?: (jr: JoinResult) => void;
  /** Test seam for the rejoiner (timings, fetch, session-file reader). */
  rejoinOverrides?: Partial<Omit<RejoinDeps, "sseMux" | "processor" | "log" | "onLost">>;
}

/**
 * Build the `RuntimeMcpServerOptions` shared by every CLI runtime entry point.
 * Pass the result straight to `createRuntimeMcpServer` / `createStdioRuntimeMcpServer`.
 */
export function buildRuntimeMcpOptions(ctx: RuntimeHandlerContext): RuntimeMcpServerOptions {
  const { processor, sseMux, joinResults, agentName, authority, onRoomJoined } = ctx;

  // A dropped event stream that retrying alone cannot fix (401/403 after a
  // server restart, or a dead URL) goes to that room's rejoiner.
  const rejoinerFor = (roomId: string) => joinResults.find((j) => j.roomId === roomId)?.rejoiner;
  sseMux.setRecoveryHandler({
    authRejected: async (roomId, status, usedToken) => {
      const r = rejoinerFor(roomId);
      return r ? r.authRejected(status, usedToken) : false;
    },
    unreachable: async (roomId) => (await rejoinerFor(roomId)?.unreachable()) ?? false,
  });

  /** POST to the room server through the data source (re-joins on a lost session). */
  const post = async (ds: RemoteRoomDataSource, path: string, body: Record<string, unknown>) => {
    try {
      const res = await ds.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { success: false, error: await res.text() };
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error && err.name === "RoomConnectionError" ? err.message : "Server unreachable.";
      return { success: false, error: msg };
    }
  };

  /** Resolve a room + named participant, then POST to the apiary server. */
  const adminAction = (build: (id: string) => { path: string; body: Record<string, unknown> }) =>
    async (room: string, participant: string) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;
      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };
      const { path, body } = build(p.id);
      return post(ds, path, body);
    };

  return {
    resolver: processor,
    toolOptions: {
      isEventSeen: (id) => processor.isEventSeen(id),
      markEventsSeen: (ids) => processor.markEventsSeen(ids),
      assignRef: (id) => processor.assignRef(id),
      resolveRef: (ref) => processor.resolveRef(ref),
    },
    authority,

    onSetMode: async (room, mode) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      processor.setModeForRoom(conn.dataSource.roomId, mode as EngagementMode, false);
      const result = await post(conn.dataSource as RemoteRoomDataSource, "/set-mode", { mode });
      if (!result.success && result.error !== "Server unreachable.") {
        return { success: false, error: `Server rejected: ${result.error}` };
      }
      // Server unreachable: the local mode is still set.
      return { success: true };
    },

    /**
     * Wait for another agent to reach a state, by polling the room server's
     * participant list. Two seconds of HTTP is far cheaper than the LLM turn
     * the agent would otherwise spend re-reading the room to check.
     */
    onWaitForAgent: async (room, participant, until, timeoutSec) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;
      const target = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!target) return { success: false, error: `Unknown participant "${participant}".` };
      if (target.id === conn.dataSource.selfId) {
        return { success: false, error: "You cannot wait for yourself." };
      }

      const readState = async (): Promise<AgentWaitState> => {
        try {
          const res = await ds.request("/participants", { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return "unknown";
          const data = (await res.json()) as {
            participants?: Array<{ id: string; agentState?: string }>;
          };
          const found = data.participants?.find((pp) => pp.id === target.id);
          const state = found?.agentState;
          return state === "idle" || state === "working" || state === "blocked" ? state : "unknown";
        } catch {
          // A transient failure must not read as a state change.
          return "unknown";
        }
      };

      const outcome = await waitForAgent({
        readState,
        until,
        timeoutMs: timeoutSec === undefined ? undefined : timeoutSec * 1000,
      });
      return { success: true, message: describeOutcome(participant, until ?? "idle", outcome) };
    },

    onPing: async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;
      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };
      return post(ds, "/ping", { participantId: p.id });
    },

    onJoinRoom: async (url, alias, nameOverride) => {
      const token = extractToken(url);
      let serverUrl: string;
      try {
        const parsed = new URL(url);
        parsed.search = "";
        serverUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        serverUrl = url.replace(/\/$/, "");
      }

      try {
        const joinName = nameOverride ?? agentName;
        const joinBody: Record<string, unknown> = { type: "agent", name: joinName };
        if (token) joinBody.token = token;

        const res = await fetch(`${serverUrl}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(joinBody),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { success: false, error: `Failed to join: ${await res.text()}` };

        const data = await res.json() as Record<string, unknown>;
        const sessionToken = String(data.sessionToken ?? "");
        const roomName = alias ?? String(data.roomName ?? "");
        const roomId = String(data.roomId ?? "");
        const roomAuthority = String(data.authority ?? "member");
        const participants = (data.participants as Participant[]) ?? [];
        const newParticipantId = String(data.participantId ?? "");

        // Joining a room this agent is already in (e.g. with a new share URL
        // after its old one stopped working) replaces that entry: the
        // processor and SSE stream ignore a second registration for the room.
        const existingIdx = joinResults.findIndex((j) => j.roomId === roomId);
        if (existingIdx >= 0) {
          sseMux.removeConnection(roomId);
          processor.disconnectRemoteRoom(roomId);
          joinResults.splice(existingIdx, 1);
        }

        const dataSource = new RemoteRoomDataSource(serverUrl, sessionToken, roomId);
        dataSource.setParticipants(participants);
        dataSource.setSelf(newParticipantId, joinName);

        // Set global selfId on first join; always set per-room selfId
        if (joinResults.length === 0) {
          processor.participantId = newParticipantId;
        }
        processor.setRoomParticipantId(roomId, newParticipantId);

        // Register in EventProcessor and SSE multiplexer
        const mode = processor.getModeForRoom(roomId) ?? "everyone";
        processor.connectRemoteRoom(dataSource, roomName);
        // The event stream opens only after the history read below has marked
        // the room's recent events as shown: the server replays them on
        // connect, and they must arrive as already-seen, not as news.

        // Track for cleanup
        const serverRoomName = String(data.roomName ?? "");
        const jr: JoinResult = {
          serverUrl,
          sessionToken,
          participantId: newParticipantId,
          roomName,
          roomId,
          authority: roomAuthority,
          participants,
          dataSource,
          liveSince: serverTimeOf(res),
          rejoin: {
            joinUrl: url,
            shareToken: token ?? undefined,
            name: joinName,
            type: "agent",
            serverRoomName,
            localTier: localTierOf(
              token ?? undefined,
              (ctx.rejoinOverrides?.readRoomSession ?? readLocalRoomSession)(serverRoomName),
            ),
          },
        };
        jr.rejoiner = new RoomRejoiner(jr, {
          ...ctx.rejoinOverrides,
          sseMux,
          processor,
          log: ctx.log,
          onLost: ctx.onRoomLost ? (_room, err) => ctx.onRoomLost!(jr, err) : undefined,
          onRejoined: ctx.onJoined ? () => ctx.onJoined!(jr) : undefined,
        });
        dataSource.setRecovery(jr.rejoiner);
        joinResults.push(jr);

        // Build recent activity lines for the response
        const conn = processor.resolve(roomName);
        let recentLines: string[] = [];
        if (conn) {
          const catchUp = await buildCatchUpLines(conn, {
            isEventSeen: (id) => processor.isEventSeen(id),
            markEventsSeen: (ids) => processor.markEventsSeen(ids),
            assignRef: (id) => processor.assignRef(id),
          });
          recentLines = catchUp.lines;
          // TODO: catchUp.imageBlocks not surfaced here — the runtime injection
          // path doesn't support image content blocks yet. Wire up when adding
          // image delivery to the tmux/HTTP agent path.
        }
        sseMux.addConnection(serverUrl, sessionToken, roomName, roomId);
        try { ctx.onJoined?.(jr); } catch { /* a failed record must not fail the join */ }

        await onRoomJoined?.();

        // Fetch this room's rules so they show up in the join response. Best
        // effort — older servers without /rules return 404 and we just skip.
        let rules: string[] | undefined;
        try {
          const rulesRes = await fetch(`${serverUrl}/rules`, {
            headers: { Authorization: `Bearer ${sessionToken}` },
          });
          if (rulesRes.ok) {
            const rulesData = (await rulesRes.json()) as { rules?: string[] };
            if (Array.isArray(rulesData.rules) && rulesData.rules.length > 0) rules = rulesData.rules;
          }
        } catch {
          /* old server or transient — skip */
        }

        return {
          success: true,
          roomName,
          agentName: joinName,
          authority: roomAuthority,
          mode,
          participants: participants
            .filter((p) => p.id !== newParticipantId)
            .map((p) => ({ name: p.name, authority: (p as any).authority ?? "member" })),
          recentLines,
          rules,
        } as JoinRoomResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Unable to connect. Is the server running? (${serverUrl}) — ${msg}` };
      }
    },

    onLeaveRoom: async (room) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const roomId = conn.dataSource.roomId;

      const idx = joinResults.findIndex((jr) => jr.roomId === roomId);
      if (idx >= 0) {
        const jr = joinResults[idx];
        jr.dataSource.setRecovery(null); // leaving on purpose: never re-join
        sseMux.removeConnection(roomId);
        processor.disconnectRemoteRoom(roomId);

        try {
          await fetch(`${jr.serverUrl}/disconnect`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${jr.sessionToken}` },
            body: JSON.stringify({}),
          });
        } catch {
          // Server may be down
        }

        joinResults.splice(idx, 1);
        try { ctx.onLeft?.(jr); } catch { /* best effort */ }
      }
      return { success: true };
    },

    // Admin actions differ only by endpoint + target tier — one helper covers all.
    onAdminSetModeFor: can(authority, "set_mode_for")
      ? (room, participant, mode) =>
          adminAction((id) => ({ path: "/set-mode", body: { participantId: id, mode } }))(room, participant)
      : undefined,
    onAdminMute: can(authority, "mute")
      ? adminAction((id) => ({ path: "/set-authority", body: { participantId: id, authority: "guest" } }))
      : undefined,
    onAdminUnmute: can(authority, "unmute")
      ? adminAction((id) => ({ path: "/set-authority", body: { participantId: id, authority: "member" } }))
      : undefined,
    onAdminKick: can(authority, "kick")
      ? adminAction((id) => ({ path: "/kick", body: { participantId: id } }))
      : undefined,
    onAdminPromote: can(authority, "promote")
      ? adminAction((id) => ({ path: "/set-authority", body: { participantId: id, authority: "product_owner" } }))
      : undefined,
    onAdminDemote: can(authority, "demote")
      ? adminAction((id) => ({ path: "/set-authority", body: { participantId: id, authority: "member" } }))
      : undefined,
  };
}
