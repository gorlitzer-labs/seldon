/**
 * Runtime MCP server — local MCP proxy for the client-side agent runtime.
 *
 * Claude Code / OpenCode connects to this local server. Tool calls are routed
 * to the right apiary server via the RoomResolver (which maps room names to
 * RemoteRoomDataSource instances).
 *
 * Tools:
 *   Always present:
 *     apiary__catch_up(room?) — with room: room catch-up. Without: list rooms + pending invites.
 *     apiary__search_by_text(room, query, count?, cursor?)
 *     apiary__search_by_message(room, ref, direction?, count?)
 *     apiary__send_message(room, content, reply_to?)
 *     apiary__set_mode(room, mode)
 *     apiary__join_room(url, alias?)
 *     apiary__leave_room(room)
 *
 *   With --admin flag:
 *     apiary__admin__set_mode_for(room, participant, mode)
 *     apiary__admin__kick(room, participant)
 */

import { createServer } from "node:http";
import { z } from "zod";
import type { WaitTarget } from "../wait-for-agent.js";
import type { RoomResolver, ToolHandlerOptions } from "../types.js";
import type { AuthorityLevel } from "../../core/types.js";
import { can } from "../../core/authority.js";
import {
  handleCatchUp,
  handleSearchByText,
  handleSearchByMessage,
  handleSendMessage,
  textResult,
} from "../tool-handlers.js";
import { MODE_DESCRIPTIONS } from "../prompts.js";
import { type EngagementMode } from "../engagement.js";

/** Modes available in the CLI runtime. */
const RUNTIME_MODES: ReadonlySet<string> = new Set<EngagementMode>([
  "everyone", "people", "agents",
  "standby-everyone", "standby-people", "standby-agents",
]);
const RUNTIME_MODES_LIST = "everyone, people, agents, standby-everyone, standby-people, standby-agents";

function isValidRuntimeMode(mode: string): mode is EngagementMode {
  return RUNTIME_MODES.has(mode);
}
import { EventEmitterAsyncResource } from "node:events"

export interface JoinRoomResult {
  success: boolean;
  error?: string;
  roomName?: string;
  agentName?: string;
  authority?: string;
  mode?: string;
  personName?: string;
  participants?: Array<{ name: string; authority: string }>;
  recentLines?: string[];
  /** Room rules — surfaced in the join response so the agent sees them on entry. */
  rules?: string[];
}

export interface RuntimeMcpServerOptions {
  resolver: RoomResolver;
  toolOptions: ToolHandlerOptions;
  /**
   * Server-granted authority for this agent's session. Drives which admin /
   * product_owner tools are exposed. When undefined or "member"/"guest", only
   * non-privileged tools are registered. Updated after each `join_room`
   * because the agent's tier can vary per room.
   */
  authority?: AuthorityLevel;
  /** Called when the agent requests joining a new room mid-session. */
  onJoinRoom?: (url: string, alias?: string, name?: string) => Promise<JoinRoomResult>;
  /** Called when the agent requests leaving a room. */
  onLeaveRoom?: (room: string) => Promise<{ success: boolean; error?: string }>;
  /** Called when the agent changes its own mode. */
  onSetMode?: (room: string, mode: string) => Promise<{ success: boolean; error?: string }>;
  /** Called when the agent pings a participant for a status check. */
  onPing?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  onWaitForAgent?: (
    room: string,
    participant: string,
    until?: WaitTarget,
    timeoutSec?: number,
  ) => Promise<{ success: boolean; message?: string; error?: string }>;
  /** Called for admin set-mode-for. */
  onAdminSetModeFor?: (room: string, participant: string, mode: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin kick. */
  onAdminKick?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin mute (demote to guest). */
  onAdminMute?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin unmute (restore to member). */
  onAdminUnmute?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin promote (elevate to product_owner). */
  onAdminPromote?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin demote (drop product_owner back to member). */
  onAdminDemote?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
}

export interface RuntimeMcpServer {
  url: string;
  stop: () => Promise<void>;
}

/** Format a rich join_room response from the callback result. */
function formatJoinResponse(result: JoinRoomResult): string {
  const lines: string[] = [];

  lines.push(`Joined ${result.roomName} as "${result.agentName}" (${result.authority})`);
  lines.push("");

  // Agents reliably answer in their own terminal, which nobody reads. From the
  // room's side that is indistinguishable from having finished — so a question
  // asked there is a silent stall. Say so explicitly on the way in; the room
  // rules tell them to ask, but not where.
  lines.push("Nobody reads your terminal — only this room:");
  lines.push("  - Ask questions and report blockers here with send_message, or they are invisible.");
  lines.push("  - Don't end a turn waiting on an answer you never posted.");
  lines.push("");

  // Mode
  if (result.mode) {
    lines.push(`Mode: ${result.mode}`);
    const desc = MODE_DESCRIPTIONS[result.mode];
    if (desc) lines.push(`  ${desc}`);
    lines.push(`  Change with set_mode.`);
    lines.push("");
  }

  // Person
  if (result.personName) {
    lines.push(`Person: ${result.personName}`);
    lines.push(`  Your person's messages always reach you regardless of mode.`);
    lines.push("");
  }

  // Room rules — surface before participants so the agent sees them prominently.
  if (result.rules && result.rules.length > 0) {
    lines.push("Room rules — follow these:");
    result.rules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
    lines.push("");
  }

  // Participants
  if (result.participants && result.participants.length > 0) {
    lines.push("Participants:");
    for (const p of result.participants) {
      lines.push(`  ${p.name} (${p.authority})`);
    }
    lines.push("");
  }

  // Recent activity
  if (result.recentLines && result.recentLines.length > 0) {
    lines.push("Recent:");
    for (const line of result.recentLines) {
      lines.push(`  ${line}`);
    }
    lines.push("");
    lines.push(`${result.recentLines.length} message${result.recentLines.length === 1 ? "" : "s"} shown. Use catch_up("${result.roomName}") for more.`);
  }

  return lines.join("\n");
}

/**
 * Every tool the runtime MCP server registers.
 *
 * Exported so launchers can name apiary's own tools to the agent CLI — Codex
 * only auto-approves per tool, not per server, so an agent spawned to sit in a
 * room needs each of these named or it blocks on a keypress nobody will press.
 * `runtime-tool-names.test.ts` fails if this drifts from what is registered.
 */
export const RUNTIME_TOOL_NAMES = [
  "apiary__catch_up",
  "apiary__search_by_text",
  "apiary__search_by_message",
  "apiary__send_message",
  "apiary__set_mode",
  "apiary__join_room",
  "apiary__leave_room",
  "apiary__ping",
  "apiary__wait_for_agent",
  "apiary__admin__set_mode_for",
  "apiary__admin__mute",
  "apiary__admin__unmute",
  "apiary__admin__kick",
  "apiary__admin__promote",
  "apiary__admin__demote",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTools(server: any, opts: RuntimeMcpServerOptions): void {
  const { resolver, toolOptions } = opts;

  // ── apiary__catch_up ────────────────────────────────────────────────────
  server.tool(
    "apiary__catch_up",
    "List your rooms and status. Call with no arguments to see connected rooms. With a room name, returns recent activity you haven't seen.",
    {
      room: z.string().optional().describe("Room name. Omit to list all connected rooms."),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ room }: { room?: string }) => {
      if (!room) {
        const rooms = resolver.listAll();
        if (rooms.length === 0) {
          return textResult("Not connected to any rooms.");
        }
        const lines = ["Connected rooms:", ""];
        for (const r of rooms) {
          const idPart = r.identifier ? ` [${r.identifier}]` : "";
          lines.push(`  ${r.name}${idPart} — ${r.mode} (${r.participantCount} participants)`);
          if (r.lastMessage) lines.push(`    Last: ${r.lastMessage}`);
        }
        return textResult(lines.join("\n"));
      }
      return handleCatchUp(resolver, { room }, toolOptions);
    },
  );

  // ── apiary__search_by_text ──────────────────────────────────────────────
  server.tool(
    "apiary__search_by_text",
    "Search chat history by keyword.",
    {
      room: z.string().describe("Room name"),
      query: z.string().describe("Keyword or phrase to search for"),
      count: z.number().int().min(1).max(10).default(3).optional()
        .describe("Number of matches (default 3)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByText(resolver, args, toolOptions) as any,
  );

  // ── apiary__search_by_message ──────────────────────────────────────────
  server.tool(
    "apiary__search_by_message",
    "Show messages around a known message ref.",
    {
      room: z.string().describe("Room name"),
      ref: z.string().describe("Message ref (e.g. #3847)"),
      direction: z.enum(["before", "after"]).default("before").optional()
        .describe("'before' to scroll back, 'after' to scroll forward"),
      count: z.number().int().min(1).max(50).default(10).optional()
        .describe("Number of messages (default 10)"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByMessage(resolver, args, toolOptions) as any,
  );

  // ── apiary__send_message ────────────────────────────────────────────────
  server.tool(
    "apiary__send_message",
    "Send a message to a room.",
    {
      room: z.string().describe("Room name"),
      content: z.string().describe("Message content. @name will notify that participant — use sparingly."),
      reply_to_id: z.string().optional()
        .describe("Message ref to reply to (e.g. #3847)."),
      attachments: z.array(z.discriminatedUnion("type", [
        z.object({
          type: z.literal("path"),
          id: z.string().describe("Stable ID (use crypto.randomUUID())"),
          name: z.string().describe("Display filename"),
          mime_type: z.string().describe("MIME type, e.g. image/png"),
          size: z.number().optional().describe("File size in bytes"),
          path: z.string().describe("Absolute local filesystem path — readable by agents on the same machine"),
        }),
        z.object({
          type: z.literal("upload"),
          id: z.string().describe("Attachment ID returned by POST /attachment"),
          name: z.string().describe("Display filename"),
          mime_type: z.string().describe("MIME type, e.g. image/png"),
          size: z.number().describe("File size in bytes"),
          url: z.string().describe("URL returned by POST /attachment"),
        }),
      ])).optional().describe("Typed file/image attachments"),
      to: z.array(z.string()).optional()
        .describe("Participant display names to whisper to. Others see [sender → recipient] but not the content. Omit for a public message."),
    },
    { readOnlyHint: false, destructiveHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSendMessage(resolver, args, toolOptions) as any,
  );

  // ── apiary__set_mode ────────────────────────────────────────────────────
  server.tool(
    "apiary__set_mode",
    "Change your engagement mode. Controls which messages are pushed to you: everyone — all messages, people — human messages only, agents — agent messages only. Prefix with standby- for @mentions only.",
    {
      room: z.string().describe("Room name"),
      mode: z.string().describe("Engagement mode"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ room, mode }: { room: string; mode: string }) => {
      if (!opts.onSetMode) return textResult("Mode changes not supported.");
      if (!isValidRuntimeMode(mode)) {
        return textResult(`Invalid mode "${mode}". Valid modes: ${RUNTIME_MODES_LIST}.`);
      }
      const result = await opts.onSetMode(room, mode);
      return result.success
        ? textResult(`Mode set to ${mode} for [${room}].`)
        : textResult(result.error ?? "Failed to set mode.");
    },
  );

  // ── apiary__join_room ──────────────────────────────────────────────────
  server.tool(
    "apiary__join_room",
    "Join a room. Returns your identity, participants, mode, and recent activity.",
    {
      url: z.string().describe("Share URL to join"),
      alias: z.string().optional().describe("Local alias for the room (if name collides)"),
      name: z.string().optional().describe("Display name to use in this room (overrides default)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ url, alias, name }: { url: string; alias?: string; name?: string }) => {
      if (!opts.onJoinRoom) return textResult("Joining rooms not supported.");
      const result = await opts.onJoinRoom(url, alias, name);
      if (!result.success) return textResult(result.error ?? "Failed to join room.");

      // Rich response if we have room details
      if (result.roomName && result.agentName) {
        return textResult(formatJoinResponse(result));
      }
      return textResult(`Joined room successfully.`);
    },
  );

  // ── apiary__leave_room ─────────────────────────────────────────────────
  server.tool(
    "apiary__leave_room",
    "Leave a room. Events stop flowing from it.",
    {
      room: z.string().describe("Room name to leave"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ room }: { room: string }) => {
      if (!opts.onLeaveRoom) return textResult("Leaving rooms not supported.");
      const result = await opts.onLeaveRoom(room);
      return result.success
        ? textResult(`Left [${room}].`)
        : textResult(result.error ?? "Failed to leave room.");
    },
  );

  // ── apiary__ping ──────────────────────────────────────────────────────
  server.tool(
    "apiary__ping",
    "Ping a participant for a status check. Non-blocking — they'll see it as context, not an interrupt.",
    {
      room: z.string().describe("Room name"),
      participant: z.string().describe("Participant name to ping"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ room, participant }: { room: string; participant: string }) => {
      if (!opts.onPing) return textResult("Ping not supported.");
      const result = await opts.onPing(room, participant);
      return result.success
        ? textResult(`Pinged ${participant} in [${room}].`)
        : textResult(result.error ?? "Failed to ping participant.");
    },
  );

  // ── apiary__wait_for_agent ─────────────────────────────────────────────
  server.tool(
    "apiary__wait_for_agent",
    "Wait until another agent is idle (finished), blocked (needs a human), or working. "
      + "Use this instead of re-reading the room in a loop to check on someone — polling costs a full turn each time, this costs one call. "
      + "Returns as soon as they reach the state, or after the timeout with whatever state they're in; call again to keep waiting.",
    {
      room: z.string().describe("Room name"),
      participant: z.string().describe("Agent to wait for"),
      until: z.enum(["idle", "blocked", "working", "change"]).optional()
        .describe("What to wait for. idle = they finished (default). blocked = they need a human. change = any state change."),
      timeout_sec: z.number().optional()
        .describe("How long to wait, in seconds. Default 60, max 120."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (
      { room, participant, until, timeout_sec }:
      { room: string; participant: string; until?: WaitTarget; timeout_sec?: number },
    ) => {
      if (!opts.onWaitForAgent) return textResult("Waiting not supported.");
      const result = await opts.onWaitForAgent(room, participant, until, timeout_sec);
      return result.success
        ? textResult(result.message ?? "Done.")
        : textResult(result.error ?? "Failed to wait.");
    },
  );

  // ── Product owner-and-up tools (mute / unmute / set_mode_for) ───────────
  // These actions are accepted by the server for both admin and product_owner;
  // expose them whenever the agent's authority meets the threshold so a
  // promoted product_owner agent can actually use its powers.
  if (can(opts.authority, "set_mode_for")) {
    server.tool(
      "apiary__admin__set_mode_for",
      "Admin: set engagement mode for another participant.",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name"),
        mode: z.string().describe("Engagement mode to set"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant, mode }: { room: string; participant: string; mode: string }) => {
        if (!opts.onAdminSetModeFor) return textResult("Admin mode changes not supported.");
        if (!isValidRuntimeMode(mode)) {
          return textResult(`Invalid mode "${mode}". Valid modes: ${RUNTIME_MODES_LIST}.`);
        }
        const result = await opts.onAdminSetModeFor(room, participant, mode);
        return result.success
          ? textResult(`Set ${participant}'s mode to ${mode} in [${room}].`)
          : textResult(result.error ?? "Failed to set mode.");
      },
    );

    server.tool(
      "apiary__admin__mute",
      "Admin: make a participant read-only (demote to guest).",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to mute"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminMute) return textResult("Admin mute not supported.");
        const result = await opts.onAdminMute(room, participant);
        return result.success
          ? textResult(`Muted ${participant} in [${room}] (guest).`)
          : textResult(result.error ?? "Failed to mute participant.");
      },
    );

    server.tool(
      "apiary__admin__unmute",
      "Admin: restore a muted participant (promote to member).",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to unmute"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminUnmute) return textResult("Admin unmute not supported.");
        const result = await opts.onAdminUnmute(room, participant);
        return result.success
          ? textResult(`Unmuted ${participant} in [${room}] (member).`)
          : textResult(result.error ?? "Failed to unmute participant.");
      },
    );

  }

  // ── Admin-only tools (kick / promote / demote) ──────────────────────────
  // Destructive or authority-escalating operations. Server gates these on
  // strict admin; mirror that here so product_owners don't get tools that the
  // server will reject anyway.
  if (can(opts.authority, "kick")) {
    server.tool(
      "apiary__admin__kick",
      "Admin: kick a participant from a room.",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to kick"),
      },
      { readOnlyHint: false, destructiveHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminKick) return textResult("Admin kick not supported.");
        const result = await opts.onAdminKick(room, participant);
        return result.success
          ? textResult(`Kicked ${participant} from [${room}].`)
          : textResult(result.error ?? "Failed to kick participant.");
      },
    );

    server.tool(
      "apiary__admin__promote",
      "Admin: promote a participant to product owner (can mute/unmute members, set modes).",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to promote"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminPromote) return textResult("Admin promote not supported.");
        const result = await opts.onAdminPromote(room, participant);
        return result.success
          ? textResult(`Promoted ${participant} to product owner in [${room}].`)
          : textResult(result.error ?? "Failed to promote participant.");
      },
    );

    server.tool(
      "apiary__admin__demote",
      "Admin: demote a product owner back to member.",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to demote"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminDemote) return textResult("Admin demote not supported.");
        const result = await opts.onAdminDemote(room, participant);
        return result.success
          ? textResult(`Demoted ${participant} to member in [${room}].`)
          : textResult(result.error ?? "Failed to demote participant.");
      },
    );
  }
}

/**
 * Create a runtime MCP server on a random localhost port (HTTP transport).
 * Returns the URL for --mcp-config and a stop function.
 */
export async function createRuntimeMcpServer(
  opts: RuntimeMcpServerOptions,
): Promise<RuntimeMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Fresh McpServer per request (McpServer only allows one active transport)
    const reqServer = new McpServer({ name: "apiary_runtime", version: "1.0.0" });
    registerTools(reqServer, opts);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await reqServer.connect(transport);

    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = undefined; }
    }

    await transport.handleRequest(req, res, body);
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not determine server port"));
    });
    httpServer.once("error", reject);
  });

  const url = `http://127.0.0.1:${port}/mcp`;

  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (!stopPromise) {
      stopPromise = new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
    return stopPromise;
  };

  return { url, stop };
}

/**
 * Create a runtime MCP server using stdio transport (stdin/stdout).
 * Used by `apiary mcp` — the server runs as a standalone process that
 * any MCP client (Claude Code, etc.) can connect to via stdio.
 *
 * Returns a stop function and signals when the transport closes.
 */
export async function createStdioRuntimeMcpServer(
  opts: RuntimeMcpServerOptions,
): Promise<{ stop: () => Promise<void>; closed: Promise<void> }> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );

  const mcpServer = new McpServer({ name: "apiary_runtime", version: "1.0.0" });
  registerTools(mcpServer, opts);

  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });

  await mcpServer.connect(transport);

  const stop = async () => {
    await transport.close();
    await mcpServer.close();
  };

  return { stop, closed };
}
