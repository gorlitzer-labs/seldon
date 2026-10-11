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
import type { RuntimeMcpServerOptions, JoinRoomResult } from "../agent/mcp/runtime.js";

/** A room the agent has joined, tracked for cache updates + cleanup. */
export interface JoinResult {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
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
}

/**
 * Build the `RuntimeMcpServerOptions` shared by every CLI runtime entry point.
 * Pass the result straight to `createRuntimeMcpServer` / `createStdioRuntimeMcpServer`.
 */
export function buildRuntimeMcpOptions(ctx: RuntimeHandlerContext): RuntimeMcpServerOptions {
  const { processor, sseMux, joinResults, agentName, authority, onRoomJoined } = ctx;

  /** Resolve a room + named participant, then POST to the apiary server. */
  const adminAction = (build: (id: string) => { path: string; body: Record<string, unknown> }) =>
    async (room: string, participant: string) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;
      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };
      const { path, body } = build(p.id);
      try {
        const res = await fetch(`${ds.serverUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
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
      try {
        const ds = conn.dataSource as RemoteRoomDataSource;
        const res = await fetch(`${ds.serverUrl}/set-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) return { success: false, error: `Server rejected: ${await res.text()}` };
      } catch {
        // Server unreachable, local mode still set
      }
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
          const res = await fetch(`${ds.serverUrl}/participants`, {
            headers: { Authorization: `Bearer ${ds.sessionToken}` },
            signal: AbortSignal.timeout(10_000),
          });
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
      try {
        const res = await fetch(`${ds.serverUrl}/ping`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
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
        sseMux.addConnection(serverUrl, sessionToken, roomName, roomId);

        // Track for cleanup
        const jr: JoinResult = {
          serverUrl,
          sessionToken,
          participantId: newParticipantId,
          roomName,
          roomId,
          authority: roomAuthority,
          participants,
          dataSource,
        };
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
