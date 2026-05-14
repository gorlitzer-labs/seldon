/**
 * Shared agent runtime setup — extracted from cli/claude/run.ts.
 *
 * Both `apiary run claude` and `apiary run opencode` use this to:
 *   1. Create SSE multiplexer + EventProcessor
 *   2. Create local runtime MCP server
 *   3. Wire up participant cache updates
 *   4. Provide cleanup
 *
 * Rooms are NOT joined during setup. The agent joins rooms by calling
 * join_room() via MCP. If --join URLs are provided, the startup event
 * asks the agent to call join_room for each URL.
 *
 * Each runtime only needs to provide its own delivery mechanism
 * (TmuxBridge for Claude, HTTP API for OpenCode).
 */

import { randomName } from "../core/names.js";
import { extractToken } from "./auth.js";
import { RemoteRoomDataSource } from "../agent/remote-room-data-source.js";
import { SseMultiplexer } from "../agent/sse-multiplexer.js";
import { EventProcessor } from "../agent/event-processor.js";
import { createRuntimeMcpServer, type RuntimeMcpServer, type JoinRoomResult } from "../agent/mcp/runtime.js";
import { buildCatchUpLines } from "../agent/tool-handlers.js";
import type { Participant, AuthorityLevel } from "../core/types.js";
import { can } from "../core/authority.js";
import type { LabeledEvent } from "../agent/multiplexer.js";
import type { ContentPart } from "../agent/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentRuntimeOptions {
  joinUrls?: string[];
  name?: string;
  /**
   * Legacy CLI surface flag. `true` is equivalent to `authority: "admin"` —
   * exposes the full set of admin tools in the local MCP server. Prefer
   * setting `authority` directly when the desired tier isn't admin.
   */
  admin?: boolean;
  /**
   * Pre-declared authority this agent expects to operate at. Drives which
   * privileged MCP tools the local server registers. The real authority is
   * still discovered + enforced by the apiary server on join — this flag is
   * only about tool exposure. Defaults to "admin" if `admin: true`,
   * undefined otherwise.
   */
  authority?: AuthorityLevel;
  extraArgs?: string[];
  /** Skip tmux/UI — deliver events as plain text to stdout. MCP server still runs. */
  headless?: boolean;
  /** Re-attach to an existing background session instead of starting a new one. */
  resume?: boolean;
  /** Spawned by room create: start tmux session but skip attach; wait for SIGTERM. */
  background?: boolean;
  /** Called after a room is successfully joined via join_room MCP tool. */
  onRoomJoined?: () => void | Promise<void>;
}

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

export interface AgentRuntimeSetup {
  agentName: string;
  joinResults: JoinResult[];
  initialParts: ContentPart[] | undefined;
  processor: EventProcessor;
  sseMux: SseMultiplexer;
  mcpServer: RuntimeMcpServer;
  wrappedSource: AsyncIterable<LabeledEvent>;
  cleanup(): Promise<void>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export async function setupAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntimeSetup> {
  const agentName = options.name ?? randomName();
  // Translate the legacy --admin flag into a tier; the new `authority` field
  // is the canonical knob.
  const authority: AuthorityLevel | undefined = options.authority
    ?? (options.admin ? "admin" : undefined);

  // ── Pending join URLs (not joined yet — agent calls join_room) ─────────

  const pendingUrls = options.joinUrls ?? [];

  // ── Mutable join results (populated as agent calls join_room) ──────────

  const joinResults: JoinResult[] = [];

  // ── Create SSE multiplexer (starts empty) ──────────────────────────────

  const sseMux = new SseMultiplexer();

  // ── Create EventProcessor (selfId set on first join_room) ──────────────

  const processor = new EventProcessor("", agentName, {
    defaultMode: "everyone",
  });

  // ── Create local runtime MCP server ───────────────────────────────────

  const mcpServer = await createRuntimeMcpServer({
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
      processor.setModeForRoom(conn.dataSource.roomId, mode as any, false);
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
        const authority = String(data.authority ?? "member");
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
          authority,
          participants,
          dataSource,
        };
        joinResults.push(jr);

        // Build recent activity lines for the response
        const conn = processor.resolve(roomName);
        let recentLines: string[] = [];
        if (conn) {
          const result = await buildCatchUpLines(conn, {
            isEventSeen: (id) => processor.isEventSeen(id),
            markEventsSeen: (ids) => processor.markEventsSeen(ids),
            assignRef: (id) => processor.assignRef(id),
          });
          recentLines = result.lines;
          // TODO: result.imageBlocks not surfaced here — runtime injection path
          // doesn't support image content blocks yet. Wire up when adding image
          // delivery to the tmux/HTTP agent path.
        }

        await options.onRoomJoined?.();

        // Fetch this room's rules so they show up in the join response. Best
        // effort — older servers without /rules return 404 and we just skip.
        let rules: string[] | undefined;
        try {
          const rulesRes = await fetch(`${serverUrl}/rules`, {
            headers: { Authorization: `Bearer ${sessionToken}` },
          });
          if (rulesRes.ok) {
            const data = (await rulesRes.json()) as { rules?: string[] };
            if (Array.isArray(data.rules) && data.rules.length > 0) rules = data.rules;
          }
        } catch {
          /* old server or transient — skip */
        }

        return {
          success: true,
          roomName,
          agentName: joinName,
          authority,
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
    onAdminSetModeFor: can(authority, "set_mode_for") ? async (room, participant, mode) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id, mode }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminMute: can(authority, "mute") ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-authority`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id, authority: "guest" }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminUnmute: can(authority, "unmute") ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-authority`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id, authority: "member" }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminKick: can(authority, "kick") ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/kick`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminPromote: can(authority, "promote") ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-authority`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id, authority: "product_owner" }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminDemote: can(authority, "demote") ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-authority`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.sessionToken}` },
          body: JSON.stringify({ participantId: p.id, authority: "member" }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
  });

  // ── Wrap SSE source for participant cache updates ─────────────────────

  const wrappedSource: AsyncIterable<LabeledEvent> = {
    [Symbol.asyncIterator]() {
      const inner = sseMux[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await inner.next();
          if (!result.done) {
            const { roomId, event } = result.value;
            const jr = joinResults.find((j) => j.roomId === roomId);
            if (jr) {
              if (event.type === "ParticipantJoined") {
                jr.dataSource.addParticipant(event.participant);
              } else if (event.type === "ParticipantLeft") {
                jr.dataSource.removeParticipant(event.participant_id);
              }
            }
          }
          return result;
        },
      };
    },
  };

  // ── Cleanup function ──────────────────────────────────────────────────

  async function cleanup(): Promise<void> {
    await processor.stop();
    sseMux.close();
    await mcpServer.stop();

    for (const jr of joinResults) {
      try {
        await fetch(`${jr.serverUrl}/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: jr.sessionToken }),
        });
      } catch {
        // Server may be down
      }
    }
  }

  // ── Build startup event (if --join URLs were provided) ────────────────

  let initialParts: ContentPart[] | undefined;
  if (pendingUrls.length > 0) {
    if (pendingUrls.length === 1) {
      initialParts = [{ type: "text", text: `Use join_room("${pendingUrls[0]}") to connect.` }];
    } else {
      const lines = pendingUrls.map((u) => `  join_room("${u}")`);
      initialParts = [{ type: "text", text: `Rooms to join:\n${lines.join("\n")}` }];
    }
  }

  return {
    agentName,
    joinResults,
    initialParts,
    processor,
    sseMux,
    mcpServer,
    wrappedSource,
    cleanup,
  };
}
