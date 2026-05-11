/**
 * Full MCP server — for embedded/API agents without filesystem access.
 *
 * Creates a proper MCP server using @modelcontextprotocol/sdk with
 * StreamableHTTP transport on a random localhost port.
 *
 * 4 tools: catch_up, search_by_text, search_by_message, send_message.
 *
 * Returns { url, instance, stop } where:
 *   url      — http://127.0.0.1:PORT/mcp (for any MCP-capable client)
 *   instance — McpServer instance (for Claude SDK in-process shortcut)
 *   stop     — shuts down the HTTP listener
 */

import { createServer } from "node:http";
import { z } from "zod";
import type { RoomResolver, ToolHandlerOptions } from "../types.js";
import {
  handleCatchUp,
  handleSearchByText,
  handleSearchByMessage,
  handleSendMessage,
} from "../tool-handlers.js";

export interface StoopsMcpServer {
  /** HTTP URL for URL-based MCP clients (e.g. LangGraph, external tools). */
  url: string;
  /**
   * Raw McpServer instance — passed to Claude SDK as
   * `{ type: 'sdk', name: 'apiary_tools', instance }` to avoid HTTP overhead.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any;
  /** Shut down the HTTP listener. */
  stop: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTools(server: any, resolver: RoomResolver, options: ToolHandlerOptions): void {
  server.tool(
    "catch_up",
    "Catch up on recent activity in a room. Returns unseen events.",
    { room: z.string().describe("Name of the room to catch up on") },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ room }: { room: string }) => handleCatchUp(resolver, { room }, options) as any,
  );

  server.tool(
    "search_by_text",
    "Search chat history by keyword.",
    {
      room: z.string().describe("Name of the room to search"),
      query: z.string().describe("Keyword or phrase to search for"),
      count: z.number().int().min(1).max(10).default(3).optional()
        .describe("Number of matches to return (default 3)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous search"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByText(resolver, args, options) as any,
  );

  server.tool(
    "search_by_message",
    "Show messages around a known message ref.",
    {
      room: z.string().describe("Name of the room"),
      ref: z.string().describe("The #XXXX message ref (e.g. #3847)"),
      direction: z.enum(["before", "after"]).default("before").optional()
        .describe("'before' to scroll back (default), 'after' to scroll forward"),
      count: z.number().int().min(1).max(50).default(10).optional()
        .describe("Number of messages to return (not counting anchor, default 10)"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByMessage(resolver, args, options) as any,
  );

  server.tool(
    "send_message",
    "Send a message to a room.",
    {
      room: z.string().describe("Name of the room to send to"),
      content: z.string().describe("Message content. @name will notify that participant — use sparingly."),
      reply_to_id: z.string().optional()
        .describe("Message ref to reply to (e.g. #3847)."),
      image_url: z.string().url().optional().describe("URL of an image to attach (legacy single-image)"),
      image_mime_type: z.string().optional().describe("MIME type of the image (legacy)"),
      image_size_bytes: z.number().int().positive().optional()
        .describe("Size of the image in bytes (legacy)"),
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
    },
    { readOnlyHint: false, destructiveHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSendMessage(resolver, args, options) as any,
  );

  server.tool(
    "ping",
    "Ping a participant for a status check. Non-blocking — they'll see it as context, not an interrupt.",
    {
      room: z.string().describe("Name of the room"),
      participant: z.string().describe("Participant name to ping"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ room, participant }: { room: string; participant: string }) => {
      const conn = resolver.resolve(room);
      if (!conn) return { content: [{ type: "text" as const, text: `Unknown room "${room}".` }] };
      if (!conn.channel) return { content: [{ type: "text" as const, text: "Ping not available for this room." }] };

      const target = conn.dataSource.listParticipants().find(
        (p) => p.name.toLowerCase() === participant.toLowerCase(),
      );
      if (!target) return { content: [{ type: "text" as const, text: `Unknown participant "${participant}".` }] };

      await conn.channel.ping(target.id);
      return { content: [{ type: "text" as const, text: `Pinged ${participant} in [${room}].` }] };
    },
  );
}

/**
 * Start a full apiary MCP server (all 4 tools).
 * Call once per session start; call stop() on session stop.
 */
export async function createFullMcpServer(
  resolver: RoomResolver,
  options: ToolHandlerOptions,
): Promise<StoopsMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  // Singleton instance for Claude SDK in-process shortcut.
  const instance = new McpServer({ name: "apiary", version: "1.0.0" });
  registerTools(instance, resolver, options);

  // ── Start HTTP server on random port ─────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Fresh McpServer per request — McpServer only allows one active transport
    // at a time, so reusing the singleton across requests causes "Already connected"
    // errors. Tool registration is cheap; creating per-request is the correct pattern
    // for stateless HTTP MCP.
    const reqServer = new McpServer({ name: "apiary", version: "1.0.0" });
    registerTools(reqServer, resolver, options);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
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

  return { url, instance, stop };
}
