/**
 * Wake an `apiary mcp` session when the room addresses it.
 *
 * `apiary mcp` is pull-based: the agent sees room traffic only when it calls
 * catch_up(), so an idle session at its prompt never notices an @mention until
 * a human types. When the MCP server runs inside tmux — Claude Code passes
 * $TMUX_PANE through to its stdio MCP servers — it can nudge that pane.
 *
 * The nudge is FIXED text built by apiary, never room content. Typed input is
 * read by the agent as its operator's instruction, and a room is shared with
 * other agents and people; letting their words arrive that way would let anyone
 * in the room drive this session. The message itself is read through
 * catch_up(), where it arrives as room data. Only the room name and the sender's
 * name are interpolated, and both are reduced to a safe character set.
 *
 * Only events addressed to this agent wake it — an @mention, a whisper naming
 * it, or a ping — whatever its engagement mode, so a busy room costs a pane
 * nothing. `APIARY_MCP_WAKE=off` turns it off.
 */

import { classifyEvent } from "../../agent/engagement.js";
import type { RoomEvent } from "../../core/events.js";
import type { Participant } from "../../core/types.js";

export type WakePolicy = "addressed" | "off";

export interface WakeConfig {
  policy: WakePolicy;
  /** tmux pane to nudge, from $TMUX_PANE. */
  pane?: string;
  /** Why waking is off, for the startup line on stderr. */
  reason?: string;
}

/** Decide whether and where to wake, from the environment. */
export function resolveWakeConfig(env: NodeJS.ProcessEnv): WakeConfig {
  const setting = (env.APIARY_MCP_WAKE ?? "addressed").trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") {
    return { policy: "off", reason: "APIARY_MCP_WAKE=off" };
  }
  const pane = env.TMUX_PANE?.trim();
  if (!pane || !/^%\d+$/.test(pane)) {
    return { policy: "off", reason: "not running inside tmux (no $TMUX_PANE)" };
  }
  return { policy: "addressed", pane };
}

export type WakeKind = "mention" | "whisper" | "ping";

/**
 * Is this event aimed at this agent? Same rule a standby agent wakes on, so
 * the two paths cannot disagree about what "addressed" means.
 */
export function addressedKind(
  event: RoomEvent,
  selfId: string,
  participants: Participant[],
): WakeKind | null {
  const senderId =
    event.type === "Mentioned" ? event.message.sender_id
    : event.type === "Pinged" ? event.pinger_id
    : event.participant_id;
  if (senderId === selfId) return null;
  const senderType = participants.find((p) => p.id === senderId)?.type ?? "human";
  if (classifyEvent(event, "standby-everyone", selfId, senderType, senderId) !== "trigger") return null;
  if (event.type === "Pinged") return "ping";
  if (event.type === "Mentioned") return "mention";
  return "whisper";
}

/** Keep a room-controlled name from carrying anything but a plain label. */
export function safeLabel(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 40);
  return cleaned || "someone";
}

const VERB: Record<WakeKind, string> = {
  mention: "mentioned you",
  whisper: "whispered to you",
  ping: "pinged you",
};

/** The one line typed into the pane. Fixed wording; two sanitised names. */
export function wakeLine(room: string, sender: string, kind: WakeKind): string {
  const r = safeLabel(room);
  return `apiary: ${safeLabel(sender)} ${VERB[kind]} in room "${r}". ` +
    `Read it with apiary__catch_up("${r}") and answer there with apiary__send_message.`;
}

export interface Nudger {
  nudge(text: string): void;
}

/**
 * Turns room events into nudges. One nudge per message: a whisper that also
 * @mentions the agent arrives as two events and must not wake it twice.
 */
export class McpWaker {
  private seen = new Set<string>();

  constructor(private nudger: Nudger) {}

  onEvent(roomName: string, event: RoomEvent, selfId: string, participants: Participant[]): boolean {
    const kind = addressedKind(event, selfId, participants);
    if (!kind) return false;

    const key = event.type === "Pinged" ? event.id : (event as { message: { id: string } }).message.id;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);

    const senderName =
      event.type === "Pinged"
        ? participants.find((p) => p.id === event.pinger_id)?.name ?? "someone"
        : (event as { message: { sender_name: string } }).message.sender_name;
    this.nudger.nudge(wakeLine(roomName, senderName, kind));
    return true;
  }
}
