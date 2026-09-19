/** Tests for engagement — classifyEvent function and StoopsEngagement class. */

import { describe, test, expect } from "vitest";
import { classifyEvent, StoopsEngagement } from "../src/agent/engagement.js";
import { createEvent } from "../src/core/events.js";
import type {
  MessageSentEvent,
  MentionedEvent,
  ToolUseEvent,
  ActivityEvent,
  ReactionAddedEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
} from "../src/core/events.js";

const SELF = "agent_quinn";
const HUMAN_ID = "user_human";
const OTHER_AGENT = "agent_ash";

const BASE = { room_id: "test" };

function makeMessage(senderId: string, content = "hello") {
  return createEvent<MessageSentEvent>({
    type: "MessageSent",
    category: "MESSAGE",
    ...BASE,
    participant_id: senderId,
    message: {
      id: "m1",
      room_id: "test",
      sender_id: senderId,
      sender_name: "Sender",
      content,
      reply_to_id: null,
      timestamp: new Date(),
    },
  });
}

/** A whisper: a message with explicit recipients, visible only to them. */
function makeWhisper(senderId: string, recipients: string[], content = "psst") {
  const event = makeMessage(senderId, content);
  (event.message as { recipients?: string[] }).recipients = recipients;
  return event;
}

function makeMentioned(mentionedId: string, senderId: string) {
  return createEvent<MentionedEvent>({
    type: "Mentioned",
    category: "MENTION",
    ...BASE,
    participant_id: mentionedId,
    message: {
      id: "m2",
      room_id: "test",
      sender_id: senderId,
      sender_name: "Sender",
      content: `@${mentionedId} hey`,
      reply_to_id: null,
      timestamp: new Date(),
    },
  });
}

function makeToolUse(participantId: string) {
  return createEvent<ToolUseEvent>({
    type: "ToolUse",
    category: "ACTIVITY",
    ...BASE,
    participant_id: participantId,
    tool_name: "list_messages",
    status: "started",
  });
}

function makeReaction(participantId: string) {
  return createEvent<ReactionAddedEvent>({
    type: "ReactionAdded",
    category: "MESSAGE",
    ...BASE,
    participant_id: participantId,
    message_id: "m1",
    emoji: "👍",
  });
}

function makeJoined(participantId: string) {
  return createEvent<ParticipantJoinedEvent>({
    type: "ParticipantJoined",
    category: "PRESENCE",
    ...BASE,
    participant_id: participantId,
    participant: { id: participantId, name: "Newcomer", status: "online", type: "human" },
  });
}

function makeLeft(participantId: string) {
  return createEvent<ParticipantLeftEvent>({
    type: "ParticipantLeft",
    category: "PRESENCE",
    ...BASE,
    participant_id: participantId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyEvent (standalone pure function)
// ═══════════════════════════════════════════════════════════════════════════════

// --- standby-everyone mode ---

describe("standby-everyone mode", () => {
  test("Mentioned to self → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("Mentioned to other → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from human → drop", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from agent → drop", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "standby-everyone", SELF, "agent", OTHER_AGENT)).toBe("drop");
  });

  test("ParticipantJoined → drop", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });
});

// --- people mode ---

describe("people mode", () => {
  test("human MessageSent → trigger", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("agent MessageSent → content", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "people", SELF, "agent", OTHER_AGENT)).toBe("content");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ReactionAdded → content", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ToolUse → drop (internal)", () => {
    expect(classifyEvent(makeToolUse(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "people", SELF, "agent", SELF)).toBe("drop");
  });
});

// --- everyone mode ---

describe("everyone mode", () => {
  test("MessageSent from human → trigger", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("MessageSent from agent → trigger", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "everyone", SELF, "agent", OTHER_AGENT)).toBe("trigger");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ToolUse → drop (internal)", () => {
    expect(classifyEvent(makeToolUse(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ReactionAdded → content", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "everyone", SELF, "agent", SELF)).toBe("drop");
  });
});

// --- agents mode ---

describe("agents mode", () => {
  test("agent MessageSent → trigger", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "agents", SELF, "agent", OTHER_AGENT)).toBe("trigger");
  });

  test("human MessageSent → content", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content (ambient)", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content (ambient)", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ReactionAdded → content (ambient)", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ContextCompacted → content", () => {
    const event = createEvent<{ type: "ContextCompacted"; category: "ACTIVITY"; room_id: string; participant_id: string; participant: { id: string; name: string; status: string; type: "human" | "agent" } }>({
      type: "ContextCompacted",
      category: "ACTIVITY",
      ...BASE,
      participant_id: HUMAN_ID,
      participant: { id: HUMAN_ID, name: "Human", status: "online", type: "human" },
    });
    expect(classifyEvent(event as any, "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "agents", SELF, "agent", SELF)).toBe("drop");
  });
});

// --- standby-people mode ---

describe("standby-people mode", () => {
  test("Mentioned to self from human → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("Mentioned to self from agent → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_AGENT), "standby-people", SELF, "agent", OTHER_AGENT)).toBe("drop");
  });

  test("Mentioned to other (not self) from human → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from human → drop", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("drop");
  });
});

// --- standby-agents mode ---

describe("standby-agents mode", () => {
  test("Mentioned to self from agent → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_AGENT), "standby-agents", SELF, "agent", OTHER_AGENT)).toBe("trigger");
  });

  test("Mentioned to self from human → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-agents", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("Mentioned to other (not self) from agent → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, OTHER_AGENT), "standby-agents", SELF, "agent", OTHER_AGENT)).toBe("drop");
  });

  test("MessageSent from agent → drop", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "standby-agents", SELF, "agent", OTHER_AGENT)).toBe("drop");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// StoopsEngagement (stateful class with per-room modes)
// ═══════════════════════════════════════════════════════════════════════════════

describe("StoopsEngagement", () => {
  test("getMode returns default when no mode set", () => {
    const eng = new StoopsEngagement("people");
    expect(eng.getMode("room-1")).toBe("people");
  });

  test("setMode / getMode round-trips", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "everyone");
    expect(eng.getMode("room-1")).toBe("everyone");
  });

  test("onRoomDisconnected reverts to default", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "everyone");
    eng.onRoomDisconnected("room-1");
    expect(eng.getMode("room-1")).toBe("people");
  });

  test("classify uses default mode for unset rooms", () => {
    const eng = new StoopsEngagement("everyone");
    // everyone mode: human message → trigger
    expect(eng.classify(makeMessage(HUMAN_ID), "room-1", SELF, "human", HUMAN_ID)).toBe("trigger");
    // everyone mode: agent message → trigger
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-1", SELF, "agent", OTHER_AGENT)).toBe("trigger");
  });

  test("different rooms have independent modes", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "everyone");
    eng.setMode("room-2", "people");
    // room-1 (everyone): agent message → trigger
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-1", SELF, "agent", OTHER_AGENT)).toBe("trigger");
    // room-2 (people): agent message → content
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-2", SELF, "agent", OTHER_AGENT)).toBe("content");
  });
});

describe("whispers wake a standby agent", () => {
  // A whisper is the room's one form of directed communication, and standby
  // means "wake when addressed". Mentioned events are only fired by scanning
  // "@token" in the text, so a whisper carries no mention — before this it was
  // dropped, and DMing a standby agent got silence.

  test("a whisper to this agent triggers", () => {
    expect(classifyEvent(makeWhisper(HUMAN_ID, [SELF]), "standby-everyone", SELF, "human", HUMAN_ID))
      .toBe("trigger");
  });

  test("a whisper to somebody else is still dropped", () => {
    // The fix must not turn standby into "wake on any whisper in the room".
    expect(classifyEvent(makeWhisper(HUMAN_ID, [OTHER_AGENT]), "standby-everyone", SELF, "human", HUMAN_ID))
      .toBe("drop");
  });

  test("a whisper naming several recipients wakes each of them", () => {
    expect(classifyEvent(makeWhisper(HUMAN_ID, [OTHER_AGENT, SELF]), "standby-everyone", SELF, "human", HUMAN_ID))
      .toBe("trigger");
  });

  test("a public message is still dropped", () => {
    // The whole point of standby: unaddressed chatter costs nothing.
    expect(classifyEvent(makeMessage(HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID))
      .toBe("drop");
  });

  test("the agent's own whisper is not echoed back to it", () => {
    expect(classifyEvent(makeWhisper(SELF, [SELF]), "standby-everyone", SELF, "agent", SELF))
      .toBe("drop");
  });

  test("standby-people: a whisper from an agent is dropped", () => {
    // The sender filter still applies — standby-people means people only.
    expect(classifyEvent(makeWhisper(OTHER_AGENT, [SELF]), "standby-people", SELF, "agent", OTHER_AGENT))
      .toBe("drop");
  });

  test("standby-people: a whisper from a human triggers", () => {
    expect(classifyEvent(makeWhisper(HUMAN_ID, [SELF]), "standby-people", SELF, "human", HUMAN_ID))
      .toBe("trigger");
  });

  test("standby-agents: a whisper from an agent triggers, from a human drops", () => {
    expect(classifyEvent(makeWhisper(OTHER_AGENT, [SELF]), "standby-agents", SELF, "agent", OTHER_AGENT))
      .toBe("trigger");
    expect(classifyEvent(makeWhisper(HUMAN_ID, [SELF]), "standby-agents", SELF, "human", HUMAN_ID))
      .toBe("drop");
  });

  test("active modes are unaffected — a whisper still triggers there", () => {
    expect(classifyEvent(makeWhisper(HUMAN_ID, [SELF]), "everyone", SELF, "human", HUMAN_ID))
      .toBe("trigger");
    expect(classifyEvent(makeWhisper(HUMAN_ID, [SELF]), "people", SELF, "human", HUMAN_ID))
      .toBe("trigger");
  });

  test("an empty recipients list is a public message, not a whisper to all", () => {
    expect(classifyEvent(makeWhisper(HUMAN_ID, []), "standby-everyone", SELF, "human", HUMAN_ID))
      .toBe("drop");
  });
});
