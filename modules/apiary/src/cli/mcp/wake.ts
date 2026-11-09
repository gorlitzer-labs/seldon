/**
 * Wake an `apiary mcp` session when the room has something for it.
 *
 * `apiary mcp` is pull-based: the agent sees room traffic only when it calls
 * catch_up(), so an idle session at its prompt never notices a message until
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
 * What wakes it follows the agent's engagement mode for that room — the same
 * promise join_room makes ("everyone — all messages are pushed to you"):
 *
 *   - active modes (everyone, people, agents): a message from someone else that
 *     the mode lets through wakes it, with "new messages in room X from Y";
 *   - standby modes: only events addressed to it — an @mention, a whisper
 *     naming it, or a ping;
 *   - in every mode, an addressed event wakes it with its own line.
 *
 * Cost and loops are bounded by coalescing: at most ONE outstanding plain
 * nudge per room until the agent calls catch_up() for that room, which re-arms
 * it. An addressed event may still wake a room that has a plain nudge
 * outstanding, but never twice for one message. The agent's own messages,
 * joins, leaves and activity never wake it.
 *
 * `APIARY_MCP_WAKE=addressed` keeps the older rule (addressed events only,
 * whatever the mode); `APIARY_MCP_WAKE=off` turns waking off.
 */

import { classifyEvent, type EngagementMode } from "../../agent/engagement.js";
import type { RoomEvent } from "../../core/events.js";
import type { Participant } from "../../core/types.js";

/**
 * - "mode"      — follow the room's engagement mode (the default)
 * - "addressed" — only @mentions, whispers and pings, whatever the mode
 * - "off"       — never nudge
 */
export type WakePolicy = "mode" | "addressed" | "off";

export interface WakeConfig {
  policy: WakePolicy;
  /** tmux pane to nudge, from $TMUX_PANE. */
  pane?: string;
  /** Why waking is off, for the startup line on stderr. */
  reason?: string;
}

/** Decide whether and where to wake, from the environment. */
export function resolveWakeConfig(env: NodeJS.ProcessEnv): WakeConfig {
  const setting = (env.APIARY_MCP_WAKE ?? "").trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") {
    return { policy: "off", reason: "APIARY_MCP_WAKE=off" };
  }
  // A test run (vitest sets VITEST, and its children inherit it) never types
  // into a pane: under tmux it would be the developer's own session. A test
  // that really wants waking opts in with APIARY_MCP_WAKE_IN_TESTS=1.
  if ((env.VITEST || env.NODE_ENV === "test") && env.APIARY_MCP_WAKE_IN_TESTS !== "1") {
    return { policy: "off", reason: "running under a test runner (APIARY_MCP_WAKE_IN_TESTS=1 to opt in)" };
  }
  const pane = env.TMUX_PANE?.trim();
  if (!pane || !/^%\d+$/.test(pane)) {
    return { policy: "off", reason: "not running inside tmux (no $TMUX_PANE)" };
  }
  return { policy: setting === "addressed" ? "addressed" : "mode", pane };
}

/** The startup line on stderr, so an operator can see which rule is live. */
export function describeWake(config: WakeConfig): string {
  if (config.policy === "off") {
    return `wake: off — ${config.reason ?? "disabled"}; call catch_up() to see room messages`;
  }
  if (config.policy === "addressed") {
    return `wake: on (APIARY_MCP_WAKE=addressed) — @mentions, whispers and pings nudge tmux pane ${config.pane}`;
  }
  return `wake: on (follows engagement mode) — in everyone/people/agents a room message from someone else ` +
    `nudges tmux pane ${config.pane}, at most once per room until catch_up; in standby only @mentions, ` +
    `whispers and pings do. APIARY_MCP_WAKE=addressed for addressed-only, =off to disable`;
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

/**
 * Is this an ordinary room message the agent's mode says should reach it?
 *
 * Only a MessageSent from someone else counts — never the agent's own message,
 * never join/leave/activity — and only when the mode's sender filter lets it
 * through (`people` wakes on humans, `agents` on other agents). Standby modes
 * never wake for an ordinary message. A whisper between two others is not
 * something the agent can read, so it does not count either.
 */
export function isRoomMessageFor(
  event: RoomEvent,
  selfId: string,
  participants: Participant[],
  mode: EngagementMode,
): boolean {
  if (event.type !== "MessageSent") return false;
  if (mode.startsWith("standby-")) return false;
  const senderId = event.message.sender_id;
  if (senderId === selfId || event.participant_id === selfId) return false;
  const recipients = event.message.recipients;
  if (recipients && recipients.length > 0 && !recipients.includes(selfId)) return false;
  const senderType = participants.find((p) => p.id === senderId)?.type ?? "human";
  return classifyEvent(event, mode, selfId, senderType, senderId) === "trigger";
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

/** The line typed for an addressed event. Fixed wording; two sanitised names. */
export function wakeLine(room: string, sender: string, kind: WakeKind): string {
  const r = safeLabel(room);
  return `apiary: ${safeLabel(sender)} ${VERB[kind]} in room "${r}". ` +
    `Read it with apiary__catch_up("${r}") and answer there with apiary__send_message.`;
}

/** The line typed for ordinary room messages. Fixed wording; two sanitised names. */
export function roomMessageLine(room: string, sender: string): string {
  const r = safeLabel(room);
  return `apiary: new messages in room "${r}" from ${safeLabel(sender)}. ` +
    `Read them with apiary__catch_up("${r}") and answer there with apiary__send_message if a reply is needed.`;
}

/** The line typed when a room is lost for good. Fixed wording; one sanitised name. */
export function lostLine(room: string): string {
  const r = safeLabel(room);
  return `apiary: lost the connection to room "${r}" and could not re-join it. ` +
    `Call apiary__catch_up("${r}") to see why.`;
}

export interface Nudger {
  nudge(text: string): void;
}

export interface McpWakerOptions {
  /** "mode" (default) follows the engagement mode; "addressed" only wakes when addressed. */
  policy?: Exclude<WakePolicy, "off">;
  /**
   * How long a plain-message nudge waits before it is typed. The server sends
   * an @mention as a MessageSent followed by a Mentioned for the same message;
   * waiting a moment lets the Mentioned upgrade it to the addressed line
   * instead of losing to the generic one. 0 types it at once.
   */
  plainDelayMs?: number;
}

/**
 * Turns room events into nudges.
 *
 * - One nudge per message: a whisper that also @mentions the agent arrives as
 *   two events and must not wake it twice.
 * - One outstanding plain nudge per room: a busy room produces one line, not
 *   one per message, until `caughtUp(room)` re-arms it.
 */
export class McpWaker {
  private seen = new Set<string>();
  /** Rooms with a nudge the agent has not answered with catch_up yet. */
  private pending = new Set<string>();
  /** Plain nudges waiting out `plainDelayMs`, by room. */
  private scheduled = new Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly policy: Exclude<WakePolicy, "off">;
  private readonly plainDelayMs: number;

  constructor(private nudger: Nudger, options: McpWakerOptions = {}) {
    this.policy = options.policy ?? "mode";
    this.plainDelayMs = options.plainDelayMs ?? 300;
  }

  /**
   * Feed one room event. `mode` is the agent's engagement mode for that room
   * (default "everyone", the MCP client's default). Returns true when the event
   * produced (or scheduled) a nudge.
   */
  onEvent(
    roomName: string,
    event: RoomEvent,
    selfId: string,
    participants: Participant[],
    mode: EngagementMode = "everyone",
  ): boolean {
    const kind = addressedKind(event, selfId, participants);
    if (kind) {
      const key = event.type === "Pinged" ? event.id : (event as { message: { id: string } }).message.id;
      if (this.seen.has(key)) return false;
      this.remember(key);
      // An addressed line covers the room: drop a plain nudge still waiting.
      this.cancelScheduled(roomName);
      this.pending.add(roomName);
      const senderName =
        event.type === "Pinged"
          ? participants.find((p) => p.id === event.pinger_id)?.name ?? "someone"
          : (event as { message: { sender_name: string } }).message.sender_name;
      this.nudger.nudge(wakeLine(roomName, senderName, kind));
      return true;
    }

    if (this.policy !== "mode") return false;
    if (!isRoomMessageFor(event, selfId, participants, mode)) return false;
    const message = (event as Extract<RoomEvent, { type: "MessageSent" }>).message;
    if (this.seen.has(message.id)) return false;
    // Coalesce: the room already has a nudge out (or one about to go out).
    if (this.pending.has(roomName) || this.scheduled.has(roomName)) return false;

    const fire = () => {
      this.scheduled.delete(roomName);
      if (this.seen.has(message.id) || this.pending.has(roomName)) return;
      this.remember(message.id);
      this.pending.add(roomName);
      this.nudger.nudge(roomMessageLine(roomName, message.sender_name));
    };
    if (this.plainDelayMs <= 0) {
      fire();
    } else {
      const timer = setTimeout(fire, this.plainDelayMs);
      timer.unref?.();
      this.scheduled.set(roomName, { messageId: message.id, timer });
    }
    return true;
  }

  /** The agent read the room (catch_up): the next message may wake it again. */
  caughtUp(roomName: string): void {
    this.pending.delete(roomName);
    this.cancelScheduled(roomName);
  }

  /** Is a nudge outstanding for this room? (For tests and the startup line.) */
  isPending(roomName: string): boolean {
    return this.pending.has(roomName) || this.scheduled.has(roomName);
  }

  /** Drop any waiting timers (on shutdown). */
  stop(): void {
    for (const room of [...this.scheduled.keys()]) this.cancelScheduled(room);
  }

  private cancelScheduled(roomName: string): void {
    const s = this.scheduled.get(roomName);
    if (!s) return;
    clearTimeout(s.timer);
    this.scheduled.delete(roomName);
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
  }
}
