/** Event formatting and mode descriptions for apiary agents. */

import type { Participant } from "../core/types.js";
import type { RoomEvent } from "../core/events.js";
import type { ContentPart } from "./types.js";

// ── Mode descriptions ────────────────────────────────────────────────────────

/** One-liner mode descriptions used in join_room responses and set_mode. */
export const MODE_DESCRIPTIONS: Record<string, string> = {
  "everyone": "All messages are pushed to you.",
  "people": "Human messages are pushed to you. Agent messages are delivered as context.",
  "agents": "Agent messages are pushed to you. Human messages are delivered as context.",
  "fight": "⚔️ FIGHT MODE. All messages trigger. Gloves are off. Talk trash, roast, clap back. No mercy.",
  "standby-everyone": "Only @mentions are pushed to you.",
  "standby-people": "Only human @mentions are pushed to you.",
  "standby-agents": "Only agent @mentions are pushed to you.",
};

// ── Formatting ────────────────────────────────────────────────────────────────

/** Short 4-char ref for a message ID, used in transcripts. */
export function messageRef(messageId: string): string {
  return messageId.replace(/-/g, "").slice(0, 4);
}

/** Format a participant as a labeled name: "[human] Alice" or "[agent] Quinn". */
export function participantLabel(p: Participant | null, fallback?: string): string {
  if (!p) return fallback ?? "someone";
  return `[${p.type}] ${p.name}`;
}

/** Resolve participant name, with fallback. */
function resolveName(resolveParticipant: (id: string) => Participant | null, id: string, fallback?: string): string {
  return resolveParticipant(id)?.name ?? fallback ?? "someone";
}

/** Format a Date as UTC HH:MM:SS for display in agent transcripts. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** Convert ContentPart[] back to a plain string (for trace logs and stats). */
export function contentPartsToString(parts: ContentPart[]): string {
  return parts.map(p => p.type === "text" ? p.text : ` [image: ${p.url}]`).join("");
}

/** Count visual character width (grapheme clusters) for padding alignment. */
function visualLength(s: string): number {
  // Use Intl.Segmenter if available (Node 16+), otherwise fall back to spread
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(s)) count++;
    return count;
  }
  return [...s].length;
}

/**
 * Format multiline content with room label continuation.
 * First line is returned as-is. Subsequent lines get [room] prefix aligned.
 */
function formatMultilineContent(content: string, roomLabel: string | undefined, prefix: string): string {
  const lines = content.split("\n");
  if (lines.length <= 1) return content;
  const continuation = roomLabel ? `[${roomLabel}] ` : "";
  // Pad continuation to align under the content start (grapheme-aware)
  const pad = " ".repeat(visualLength(prefix));
  return lines[0] + "\n" + lines.slice(1).map(l => `${pad}${continuation}${l}`).join("\n");
}

/**
 * Render `prefix` followed by content whose wrapped continuation lines align
 * under the text after `prefix`. Passing `prefix` in one place keeps the visible
 * prefix and the alignment padding from silently drifting apart.
 */
function renderLine(prefix: string, content: string, roomLabel: string | undefined): string {
  return `${prefix}${formatMultilineContent(content, roomLabel, prefix)}`;
}

/**
 * Format a typed event as ContentPart[] for the LLM session.
 * Returns null for events that shouldn't be sent to the LLM (noise).
 *
 * Compact one-liner format:
 *   Messages:  [14:23:01] #3847 [lobby] Alice: hey everyone
 *   Replies:   [14:23:01] #9102 [lobby] Alice (→ #3847 Bob): good point
 *   Mentions:  [14:23:01] #5521 [lobby] ⚡ Alice: @bot what do you think?
 *   Joined:    [14:23:01] [lobby] + Alice joined
 *   Left:      [14:23:15] [lobby] - Bob left
 *   Reactions:  [14:23:20] [lobby] Alice reacted ❤️ to #3847
 */
export function formatEvent(
  event: RoomEvent,
  resolveParticipant: (id: string) => Participant | null,
  replyContext?: { senderName: string; content: string } | null,
  roomLabel?: string,
  reactionTarget?: { senderName: string; content: string; isSelf: boolean } | null,
  assignRef?: (messageId: string) => string,
): ContentPart[] | null {
  const r = roomLabel ? `[${roomLabel}] ` : "";
  const ts = `[${formatTimestamp("timestamp" in event ? new Date(event.timestamp as Date) : new Date())}] `;
  const mkRef = (id: string) => `#${assignRef ? assignRef(id) : messageRef(id)}`;

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const name = resolveName(resolveParticipant, msg.sender_id, msg.sender_name);
      const ref = mkRef(msg.id);
      const linePrefix = `${ts}${ref} ${r}`;
      let text: string;
      if (msg.reply_to_id && replyContext) {
        const rRef = assignRef ? mkRef(msg.reply_to_id) : ref;
        text = renderLine(`${linePrefix}${name} (→ ${rRef} ${replyContext.senderName}): `, msg.content, roomLabel);
      } else {
        text = renderLine(`${linePrefix}${name}: `, msg.content, roomLabel);
      }
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "Mentioned": {
      const msg = event.message;
      const name = resolveName(resolveParticipant, msg.sender_id, msg.sender_name);
      const ref = mkRef(msg.id);
      const linePrefix = `${ts}${ref} ${r}⚡ `;
      const text = renderLine(`${linePrefix}${name}: `, msg.content, roomLabel);
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "Pinged": {
      const pingerName = event.pinger_name ?? "someone";
      return [{ type: "text", text: `${ts}${r}🔔 ${pingerName} pinged you — respond NOW with a one-line status of what you're working on. Keep it short, don't stop your current task.` }];
    }
    case "ToolUse":
      return null;
    case "Activity":
      return null;
    case "ReactionAdded": {
      const name = resolveName(resolveParticipant, event.participant_id);
      const targetRef = reactionTarget ? ` to ${mkRef(event.message_id)}` : "";
      return [{ type: "text", text: `${ts}${r}${name} reacted ${event.emoji}${targetRef}` }];
    }
    case "ReactionRemoved":
      return null;
    case "ParticipantJoined": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}+ ${name} joined` }];
    }
    case "ParticipantLeft": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}- ${name} left` }];
    }
    case "ParticipantKicked": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}${name} was kicked` }];
    }
    case "AuthorityChanged": {
      const name = event.participant?.name ?? "someone";
      if (event.new_authority === "guest") {
        return [{ type: "text", text: `${ts}${r}${name} was muted` }];
      }
      if (event.new_authority === "member") {
        return [{ type: "text", text: `${ts}${r}${name} was unmuted` }];
      }
      if (event.new_authority === "product_owner") {
        return [{ type: "text", text: `${ts}${r}${name} was promoted to product owner` }];
      }
      return [{ type: "text", text: `${ts}${r}${name} → ${event.new_authority}` }];
    }
    case "ContextCompacted":
      return null;
    default:
      return null;
  }
}
