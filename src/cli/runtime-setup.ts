/**
 * Shared agent runtime setup — extracted from cli/claude/run.ts.
 *
 * Both `apiary run claude` and `apiary run opencode` use this to:
 *   1. Create SSE multiplexer + EventProcessor
 *   2. Create local runtime MCP server (handlers shared via runtime-handlers.ts)
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
import { SseMultiplexer } from "../agent/sse-multiplexer.js";
import { EventProcessor } from "../agent/event-processor.js";
import { createRuntimeMcpServer, type RuntimeMcpServer } from "../agent/mcp/runtime.js";
import type { AuthorityLevel } from "../core/types.js";
import type { LabeledEvent } from "../agent/multiplexer.js";
import type { ContentPart } from "../agent/types.js";
import { buildRuntimeMcpOptions, type JoinResult } from "./runtime-handlers.js";

export type { JoinResult };

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

  // ── Create local runtime MCP server (shared handler set) ───────────────
  const mcpServer = await createRuntimeMcpServer(
    buildRuntimeMcpOptions({
      processor,
      sseMux,
      joinResults,
      agentName,
      authority,
      onRoomJoined: options.onRoomJoined,
    }),
  );

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
