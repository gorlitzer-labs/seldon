/**
 * Shared interfaces for apiary agent infrastructure.
 *
 * Two layers:
 *
 *   EventProcessor  ──deliver()──►  Consumer (tmux, HTTP API, etc.)
 *
 * EventProcessor owns the event loop, engagement, formatting.
 * Consumers own LLM delivery, MCP servers, compaction, stats.
 */

import type { Room } from "../core/room.js";
import type { Channel } from "../core/channel.js";
import type { RoomDataSource } from "./room-data-source.js";

// ── Content ───────────────────────────────────────────────────────────────────

/**
 * A structured content item delivered to the consumer.
 *
 * Text parts carry formatted event text; image parts carry the URL of an
 * attached image so vision-capable consumers can see it natively.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

// ── Room resolution ───────────────────────────────────────────────────────────

/**
 * A resolved room connection: the data source, the room's display name,
 * and optional direct room/channel references for backward compatibility.
 *
 * Tool handlers and EventProcessor use `dataSource` for all data access.
 * Direct `room`/`channel` access is kept for app-path consumers that need it.
 */
export interface RoomConnection {
  dataSource: RoomDataSource;
  /** Present for local (app-path) rooms; absent for remote rooms. */
  room?: Room;
  /** Present for local (app-path) rooms; absent for remote rooms. */
  channel?: Channel;
  name: string;
}

/**
 * Maps room names (and identifiers) to their live connections.
 *
 * Implemented by `EventProcessor`. Tool handlers and sessions receive a
 * `RoomResolver` so they can look up rooms by the names the LLM uses.
 */
export interface RoomResolver {
  /** Resolve a room by display name, identifier slug, or room ID. Returns null if unknown. */
  resolve(roomName: string): RoomConnection | null;
  /** List all currently connected rooms with metadata. */
  listAll(): Array<{
    name: string;
    roomId: string;
    identifier?: string;
    mode: string;
    participantCount: number;
    lastMessage?: string;
  }>;
}

// ── Processor bridge ────────────────────────────────────────────────────────

/** Callbacks that bridge the session to the EventProcessor. */
export interface ProcessorBridge {
  isEventSeen?: (eventId: string) => boolean;
  markEventsSeen?: (eventIds: string[]) => void;
  assignRef?: (messageId: string) => string;
  resolveRef?: (ref: string) => string | undefined;
  onContextCompacted?: () => void;
  onToolUse?: (toolName: string, status: "started" | "completed") => void;
}

/** Subset of ProcessorBridge used by tool handlers and MCP server. */
export type ToolHandlerOptions = Pick<ProcessorBridge, "isEventSeen" | "markEventsSeen" | "assignRef" | "resolveRef">;
