/**
 * Engagement — controls which room events trigger LLM evaluation.
 *
 * # Overview
 *
 * Every event that reaches an agent is classified into one of three dispositions:
 * - "trigger"  — evaluate now (start an LLM call)
 * - "content"  — buffer as context; deliver to LLM on the next trigger
 * - "drop"     — ignore entirely (not delivered to LLM)
 *
 * The `EngagementStrategy` interface defines this contract. Implement it to
 * customize when your agent responds. The built-in `StoopsEngagement` provides
 * a 7-mode system; `classifyEvent()` is a standalone convenience function
 * using the same logic.
 *
 * # Built-in modes (StoopsEngagement / classifyEvent)
 *
 * Active modes (agent evaluates on matching messages):
 * - "everyone"  — all messages trigger evaluation
 * - "people"    — only messages from human participants trigger evaluation
 * - "agents"    — only messages from other agents trigger evaluation
 * - "fight"     — all messages trigger (novelty roast mode)
 *
 * Standby modes (agent only wakes on @mentions):
 * - "standby-everyone" — any @mention wakes the agent
 * - "standby-people"   — only @mentions from humans wake the agent
 * - "standby-agents"   — only @mentions from other agents wake the agent
 *
 * # Classification rules (in order)
 *
 * 1. Internal events (bookkeeping: edits, deletes, status changes, agent
 *    activity) → always drop
 * 2. Self-sent events → drop (the agent ignores its own activity).
 *    Exception: mentions are not self-dropped — a standby agent should wake
 *    if it is @mentioned, even if the mention event's participant_id is itself.
 * 3. Standby modes: only @mentions directed at the agent from a matching
 *    sender → trigger; everything else → drop.
 * 4. Active modes, @mention → drop (the MessageSent event already carries the
 *    @mention text; delivering both would be redundant).
 * 5. Active modes, message from matching sender → trigger
 * 6. Active modes, message from non-matching sender → content (buffered context)
 * 7. Active modes, ambient event (join/leave/reaction) → content
 */

import { EVENT_ROLE } from "../core/events.js";
import type { RoomEvent } from "../core/events.js";
import type { ParticipantType } from "../core/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The outcome of classifying an event for a given agent.
 *
 * - "trigger" — run an LLM evaluation now
 * - "content" — buffer as context; include with the next evaluation
 * - "drop"    — discard; never shown to the LLM
 */
export type EventDisposition = "trigger" | "content" | "drop";

/**
 * Engagement strategy — decides which events trigger LLM evaluation.
 *
 * Implement this to customize when your agent responds. The runtime calls
 * `classify()` for every incoming event and acts on the returned disposition.
 *
 * @example
 * // Respond to everything:
 * class AlwaysEngage implements EngagementStrategy {
 *   classify(event, roomId, selfId) {
 *     if (event.participant_id === selfId) return "drop";
 *     return "trigger";
 *   }
 * }
 */
export interface EngagementStrategy {
  /**
   * Classify a room event for this agent.
   *
   * @param event      — the room event to classify
   * @param roomId     — the room the event came from
   * @param selfId     — the agent's own participant ID (to drop self-events)
   * @param senderType — "human" or "agent" for the event's sender
   * @param senderId   — participant ID of the sender. For `Mentioned` events,
   *                     pass `event.message.sender_id` (who wrote the mention),
   *                     not `event.participant_id` (who was mentioned).
   */
  classify(
    event: RoomEvent,
    roomId: string,
    selfId: string,
    senderType: ParticipantType,
    senderId: string,
  ): EventDisposition;

  /**
   * Return the current engagement mode for a room.
   *
   * Optional — strategies that don't use named modes may omit this.
   * The runtime falls back to `"everyone"` when absent.
   */
  getMode?(roomId: string): EngagementMode;

  /**
   * Update the engagement mode for a room.
   *
   * Optional — called by the runtime when a room connects with an initial mode
   * or when the user changes the mode at runtime. Strategies that don't use
   * named modes may omit this; the call will be silently ignored.
   */
  setMode?(roomId: string, mode: EngagementMode): void;

  /**
   * Called when a room is disconnected from the runtime.
   *
   * Optional — use this for cleanup, e.g. removing per-room state that is
   * no longer needed. Strategies with no per-room state may omit this.
   */
  onRoomDisconnected?(roomId: string): void;
}

// ── Built-in modes ────────────────────────────────────────────────────────────

export type EngagementMode =
  | "people" | "agents" | "everyone" | "fight"
  | "standby-people" | "standby-agents" | "standby-everyone";

// ── Core classification logic (shared) ────────────────────────────────────────

function senderMatches(
  filter: string,
  senderType: ParticipantType,
  senderId: string,
): boolean {
  switch (filter) {
    case "everyone": return true;
    case "fight":    return true;
    case "people":   return senderType === "human";
    case "agents":   return senderType === "agent";
    default:         return false;
  }
}

/**
 * True if `event` is a whisper (a message with explicit recipients) and this
 * agent is one of them.
 *
 * Note this reads `message.recipients`, not `participant_id` — on a
 * MessageSent the latter is the SENDER, unlike mention and ping events where
 * it is the recipient.
 */
function isWhisperTo(event: RoomEvent, selfId: string): boolean {
  if (event.type !== "MessageSent") return false;
  const recipients = event.message.recipients;
  if (!recipients || recipients.length === 0) return false;
  return recipients.includes(selfId);
}

/** Internal classification logic shared by classifyEvent() and StoopsEngagement. */
function classify(
  event: RoomEvent,
  mode: EngagementMode,
  selfId: string,
  senderType: ParticipantType,
  senderId: string,
): EventDisposition {
  // 1. Internal events (agent activity, edits, deletes, status) — always drop.
  const role = EVENT_ROLE[event.type];
  if (role === "internal") return "drop";

  // 2. Self-sent events — drop. Skip this check for mentions and pings: a
  //    standby agent should wake when @mentioned or pinged, and the event's
  //    participant_id is the recipient (the agent itself), not the sender.
  if (role !== "mention" && role !== "ping" && event.participant_id === selfId) return "drop";

  const isStandby = mode.startsWith("standby-");
  const filter = isStandby ? mode.slice(8) : mode; // "standby-people" → "people"

  // 3. Standby: only things ADDRESSED TO THIS AGENT wake it; everything else
  //    is dropped entirely.
  if (isStandby) {
    if (
      (role === "mention" || role === "ping") &&
      event.participant_id === selfId &&
      senderMatches(filter, senderType, senderId)
    ) return "trigger";
    // A whisper names its recipients explicitly, which is addressing the agent
    // just as directly as an @mention — more so, since only they can see it.
    // Mentioned events are only fired by scanning "@token" in the text, so a
    // whisper carries no mention and would otherwise be dropped: the room's
    // one form of directed communication, silently ignored.
    if (isWhisperTo(event, selfId) && senderMatches(filter, senderType, senderId)) return "trigger";
    return "drop";
  }

  // 4a. Active: ping → trigger. Pings are status checks — they trigger
  //     immediate evaluation so the agent responds quickly with its status.
  if (role === "ping") return "trigger";

  // 4b. Active: @mention → drop. The MessageSent event already carries the
  //     @mention text, so delivering a separate Mentioned event would be redundant.
  if (role === "mention") return "drop";

  // 5–6. Active: message → trigger if sender matches filter, content otherwise.
  if (role === "message") {
    return senderMatches(filter, senderType, senderId)
      ? "trigger"
      : "content";
  }

  // 7. Active: ambient event (join, leave, reaction, compaction) → buffer as context.
  if (role === "ambient") return "content";

  return "drop";
}

// ── StoopsEngagement (stateful, per-room modes) ──────────────────────────────

/**
 * StoopsEngagement — the built-in engagement strategy.
 *
 * Implements the 7-mode system: 4 active modes (everyone/people/agents/fight)
 * and 3 standby modes that only wake on @mentions. Maintains per-room mode
 * state internally.
 *
 * @example
 * const engagement = new StoopsEngagement("people");
 * engagement.setMode("room-1", "agents");
 * engagement.classify(event, "room-1", selfId, "human", senderId);
 */
export class StoopsEngagement implements EngagementStrategy {
  private _modes = new Map<string, EngagementMode>();
  private _defaultMode: EngagementMode;

  constructor(defaultMode: EngagementMode) {
    this._defaultMode = defaultMode;
  }

  /** Get the engagement mode for a room. Falls back to the default mode. */
  getMode(roomId: string): EngagementMode {
    return this._modes.get(roomId) ?? this._defaultMode;
  }

  /** Set the engagement mode for a room. */
  setMode(roomId: string, mode: EngagementMode): void {
    this._modes.set(roomId, mode);
  }

  /** Called when a room is disconnected. Removes the room's mode so it doesn't linger. */
  onRoomDisconnected(roomId: string): void {
    this._modes.delete(roomId);
  }

  classify(
    event: RoomEvent,
    roomId: string,
    selfId: string,
    senderType: ParticipantType,
    senderId: string,
  ): EventDisposition {
    const mode = this._modes.get(roomId) ?? this._defaultMode;
    return classify(event, mode, selfId, senderType, senderId);
  }
}

// ── Standalone convenience function ──────────────────────────────────────────

/**
 * Classify a room event for an agent with the given engagement mode.
 *
 * Pure function — no state, no side effects, no SDK dependency.
 * Uses the same classification logic as `StoopsEngagement` but takes all
 * parameters explicitly. Useful for one-off classification or testing.
 *
 * @param event                — the event to classify
 * @param mode                 — the agent's current engagement mode for this room
 * @param selfId               — the agent's own participant ID (to drop self-events)
 * @param senderType           — type of the participant who caused the event
 * @param senderId             — participant ID of the sender.
 *                               For `Mentioned` events, pass `event.message.sender_id`
 *                               (who wrote the mention), not `event.participant_id`
 *                               (who was mentioned).
 */
export function classifyEvent(
  event: RoomEvent,
  mode: EngagementMode,
  selfId: string,
  senderType: ParticipantType,
  senderId: string,
): EventDisposition {
  return classify(event, mode, selfId, senderType, senderId);
}
