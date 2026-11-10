/**
 * The event stream as `apiary mcp` consumes it: every event keeps the joined
 * room's local view current (participants, kicks) and is offered to the waker.
 *
 * Kept apart from run.ts so the path from the SSE stream to a nudge can be
 * tested end to end — that is where 1.15.0 went wrong: the server replays the
 * room's last 50 events on every stream connect, and the waker took that
 * replay for live traffic, so an agent was woken by its own room's history
 * (an older seat's message under the same name) right after joining.
 */

import type { LabeledEvent } from "../../agent/multiplexer.js";
import type { EngagementMode } from "../../agent/engagement.js";
import { trackRoomEvent, type JoinResult } from "../runtime-handlers.js";
import type { McpWaker } from "./wake.js";

export interface WakeSourceDeps {
  joinResults: JoinResult[];
  processor: { getModeForRoom(roomId: string): EngagementMode };
  waker: McpWaker | null;
  /** The stream reported this agent kicked from a room (room memory forgets it). */
  onRemoved?: (jr: JoinResult) => void;
}

export function wakeSource(inner: AsyncIterable<LabeledEvent>, deps: WakeSourceDeps): AsyncIterable<LabeledEvent> {
  const { joinResults, processor, waker } = deps;
  return {
    [Symbol.asyncIterator]() {
      const it = inner[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await it.next();
          if (!result.done) {
            const { roomId, event } = result.value;
            const jr = joinResults.find((j) => j.roomId === roomId);
            if (jr) {
              const wasRemoved = jr.removedBy;
              trackRoomEvent(jr, event);
              if (!wasRemoved && jr.removedBy) {
                try { deps.onRemoved?.(jr); } catch { /* best effort */ }
              }
              try {
                waker?.onEvent(
                  jr.roomName,
                  event,
                  jr.participantId,
                  jr.dataSource.listParticipants(),
                  processor.getModeForRoom(roomId),
                  { liveSince: jr.liveSince, selfName: jr.rejoin.name },
                );
              } catch {
                // A failed nudge must never stop the event stream; catch_up still works.
              }
            }
          }
          return result;
        },
      };
    },
  };
}
