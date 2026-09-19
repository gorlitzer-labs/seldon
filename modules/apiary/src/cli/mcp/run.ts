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

  // ── Create stdio MCP server (shared handler set) ──────────────────────
  const mcpServer = await createStdioRuntimeMcpServer(
    buildRuntimeMcpOptions({ processor, sseMux, joinResults, agentName, authority }),
  );

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
