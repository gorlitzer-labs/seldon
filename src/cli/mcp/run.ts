/**
 * apiary mcp — standalone MCP server for any MCP client.
 *
 * Unlike `apiary claude` (which wraps Claude Code in tmux), this exposes
 * apiary tools as a stdio MCP server. Any MCP client (Claude Code, Cursor,
 * Windsurf, etc.) can add it to their MCP config and call join_room()
 * to participate in apiary rooms on the fly.
 *
 * No tmux. No wrapper. Just tools.
 *
 * Event delivery is pull-based: the agent calls catch_up() to get new events.
 * The EventProcessor still runs in the background, classifying events via the
 * engagement model and buffering content — catch_up() returns the formatted,
 * classified result.
 */

import { randomName } from "../../core/names.js";
import { extractToken } from "../auth.js";
import { RemoteRoomDataSource } from "../../agent/remote-room-data-source.js";
import { SseMultiplexer } from "../../agent/sse-multiplexer.js";
import { EventProcessor } from "../../agent/event-processor.js";
import { createStdioRuntimeMcpServer } from "../../agent/mcp/runtime.js";
import { buildCatchUpLines } from "../../agent/tool-handlers.js";
import type { Participant } from "../../core/types.js";
import type { LabeledEvent } from "../../agent/multiplexer.js";
import type { ContentPart } from "../../agent/types.js";
import type { JoinRoomResult } from "../../agent/mcp/runtime.js";
import type { EngagementMode } from "../../agent/engagement.js";

export interface McpServerOptions {
  name?: string;
  admin?: boolean;
  joinUrls?: string[];
}

interface JoinResult {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const agentName = options.name ?? randomName();
  const joinResults: JoinResult[] = [];

  // ── SSE multiplexer (starts empty, grows as agent joins rooms) ────────
  const sseMux = new SseMultiplexer();

  // ── EventProcessor (selfId set on first join) ─────────────────────────
  const processor = new EventProcessor("", agentName, {
    defaultMode: "everyone",
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

  // ── Create stdio MCP server ───────────────────────────────────────────
  const mcpServer = await createStdioRuntimeMcpServer({
    resolver: processor,
    toolOptions: {
      isEventSeen: (id) => processor.isEventSeen(id),
      markEventsSeen: (ids) => processor.markEventsSeen(ids),
      assignRef: (id) => processor.assignRef(id),
      resolveRef: (ref) => processor.resolveRef(ref),
    },
    admin: options.admin,
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
    onAdminSetModeFor: options.admin ? async (room, participant, mode) => {
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
    onAdminMute: options.admin ? async (room, participant) => {
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
    onAdminUnmute: options.admin ? async (room, participant) => {
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
    onAdminKick: options.admin ? async (room, participant) => {
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
  });

  // ── Start event loop in background ────────────────────────────────────
  // Delivery is a no-op: events are buffered in the EventProcessor and
  // returned via catch_up(). We still run the loop so engagement
  // classification, buffering, and seen-event tracking happen in real-time.
  const deliver = async (_parts: ContentPart[]) => {
    // No-op — standalone MCP is pull-based.
    // Events are classified and buffered by EventProcessor.
    // Agent pulls them via catch_up().
  };

  const eventLoopPromise = processor
    .run(deliver, wrappedSource)
    .catch(() => {});

  process.stderr.write(`apiary mcp server running as "${agentName}"\n`);
  if (options.joinUrls && options.joinUrls.length > 0) {
    process.stderr.write(`pending rooms: ${options.joinUrls.join(", ")}\n`);
  }
  process.stderr.write(`use join_room(url) to connect to a room\n`);

  // ── Cleanup ───────────────────────────────────────────────────────────

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

  // Wait for stdio transport to close (MCP client disconnected)
  // or process signal
  await Promise.race([
    mcpServer.closed,
    new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    }),
  ]);

  await cleanup();
  await eventLoopPromise;
}
