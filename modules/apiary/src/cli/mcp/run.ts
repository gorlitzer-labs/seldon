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
 * Inside tmux, room messages also nudge its pane as its engagement mode says
 * (see wake.ts), so an idle session notices them without anyone typing.
 * A lost session (server restart, dead URL) is re-joined (see rejoin.ts).
 * The EventProcessor still runs in the background, classifying events via the
 * engagement model and buffering content — catch_up() returns the formatted,
 * classified result.
 *
 * The MCP tool handlers are the same ones the tmux/HTTP runtimes use; they are
 * built by the shared runtime-handlers factory so this path can't drift.
 */

import { randomName } from "../../core/names.js";
import { EventProcessor } from "../../agent/event-processor.js";
import { SseMultiplexer } from "../../agent/sse-multiplexer.js";
import { createStdioRuntimeMcpServer } from "../../agent/mcp/runtime.js";
import type { AuthorityLevel } from "../../core/types.js";
import type { LabeledEvent } from "../../agent/multiplexer.js";
import type { ContentPart } from "../../agent/types.js";
import { buildRuntimeMcpOptions, type JoinResult } from "../runtime-handlers.js";
import { TmuxBridge } from "../claude/tmux-bridge.js";
import { McpWaker, describeWake, lostLine, resolveWakeConfig } from "./wake.js";
import { wakeSource } from "./wake-source.js";
import { RoomMemory, memoryKey, memoryPath, resolveRememberConfig, restoreRooms } from "./remember.js";

export interface McpServerOptions {
  name?: string;
  /** Legacy CLI surface flag. Equivalent to `authority: "admin"`. */
  admin?: boolean;
  /** Pre-declared authority for tool exposure. See AgentRuntimeOptions. */
  authority?: AuthorityLevel;
  joinUrls?: string[];
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const agentName = options.name ?? randomName();
  const authority: AuthorityLevel | undefined = options.authority
    ?? (options.admin ? "admin" : undefined);
  const joinResults: JoinResult[] = [];

  // ── SSE multiplexer (starts empty, grows as agent joins rooms) ────────
  const sseMux = new SseMultiplexer();

  // ── EventProcessor (selfId set on first join) ─────────────────────────
  const processor = new EventProcessor("", agentName, {
    defaultMode: "everyone",
    pullOnly: true,
  });

  // ── Wake the session's own tmux pane when the room has something for it ─
  const wake = resolveWakeConfig(process.env);
  const bridge = wake.pane && wake.policy !== "off" ? new TmuxBridge(wake.pane, { attended: true }) : null;
  const nudge = (text: string) => {
    bridge?.deliver([{ type: "text", text }], { dedupe: true }).catch(() => {});
  };
  const waker = bridge && wake.policy !== "off"
    ? new McpWaker({ nudge }, {
        policy: wake.policy,
        // Already shown to the agent (join's recent activity, catch_up): not news.
        isSeen: (eventId) => processor.isEventSeen(eventId),
      })
    : null;

  // ── Remember rooms across a restart of this session (see remember.ts) ──
  const remember = resolveRememberConfig(process.env);
  const memory = remember.enabled ? new RoomMemory(memoryPath(memoryKey(process.env, process.cwd()))) : null;
  const forget = (jr: JoinResult) => memory?.forget(jr.rejoin.serverRoomName || jr.roomName);
  const notices: string[] = [];

  // ── Wrap SSE source for participant cache updates and wake-ups ────────
  const wrappedSource: AsyncIterable<LabeledEvent> = wakeSource(sseMux, {
    joinResults,
    processor,
    waker,
    onRemoved: forget, // kicked: never come back on our own
  });

  // ── Create stdio MCP server (shared handler set) ──────────────────────
  // Re-joins after a server restart or a dead URL are logged on stderr; a
  // room lost for good also nudges the pane (fixed text) so an idle agent
  // finds out without waiting for its next call.
  const log = (line: string) => process.stderr.write(`apiary: ${line}\n`);
  const mcpOptions = buildRuntimeMcpOptions({
    processor,
    sseMux,
    joinResults,
    agentName,
    authority,
    log,
    onRoomLost: (jr) => {
      forget(jr); // the link, the seat or the agent's place is gone for good
      if (waker) nudge(lostLine(jr.roomName));
    },
    onJoined: (jr) => memory?.remember(jr),
    onLeft: forget,
  });
  const mcpServer = await createStdioRuntimeMcpServer({
    ...mcpOptions,
    takeNotices: () => notices.splice(0),
    // Reading a room re-arms its wake-up.
    onCatchUp: (room) => {
      const roomId = processor.resolve(room)?.dataSource.roomId;
      const jr = joinResults.find((j) => j.roomId === roomId);
      if (jr) waker?.caughtUp(jr.roomName);
    },
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
  process.stderr.write(`${describeWake(wake)}\n`);

  // Rooms from the last session: join them again in the background, under
  // the same names. Each outcome becomes a note in the next catch_up.
  const remembered = memory?.list() ?? [];
  process.stderr.write(
    memory
      ? `rooms: remembered in ${memory.file}${remembered.length ? `; rejoining ${remembered.length}` : ""}\n`
      : `rooms: not remembered — ${remember.reason}\n`,
  );
  if (memory && remembered.length > 0 && mcpOptions.onJoinRoom) {
    const join = mcpOptions.onJoinRoom;
    void restoreRooms(remembered, {
      join: (url, alias, name) => join(url, alias, name),
      forget: (roomName) => memory.forget(roomName),
      log,
    }).then((n) => notices.push(...n), () => {});
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  async function cleanup(): Promise<void> {
    waker?.stop();
    bridge?.stop();
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
