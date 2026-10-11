/**
 * Terminate the local agent runtime behind a room participant.
 *
 * `/kick` used to only sever the room connection: the channel closed, the token
 * was revoked, the SSE stream ended — and the agent's process and tmux session
 * carried on, reasoning about work it could no longer tell anyone about. The
 * operator's reasonable expectation is that kicking an agent the room started
 * also stops it, and the machinery already existed in `apiary stop`; it simply
 * was not wired to kick.
 *
 * Only agents THIS machine started are stopped. An agent that joined over the
 * network belongs to whoever launched it, and a room has no business reaching
 * across a tailnet to kill someone else's process — that one is still only
 * disconnected, which is all a room can honestly do.
 */

import {
  clearAgentSession,
  isAgentAlive,
  listAgentSessions,
  type AgentRuntime,
  type AgentSession,
} from "./agent-session.js";

const RUNTIMES: readonly AgentRuntime[] = ["claude", "codex", "opencode"];

export interface TerminateDeps {
  /** Every locally recorded session, across runtimes. Injected for tests. */
  list?: (runtime: AgentRuntime) => AgentSession[];
  alive?: (session: AgentSession) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  killTmux?: (session: string) => void;
  clear?: (runtime: AgentRuntime, name: string) => void;
}

export type TerminateOutcome =
  /** A local runtime was found alive and signalled. */
  | { stopped: true; runtime: AgentRuntime; pid: number; tmuxSession: string }
  /** Nothing local to stop — a remote agent, or one already gone. */
  | { stopped: false; reason: "not-local" | "already-exited" };

/**
 * Find the local runtime for `agentName` and stop it: SIGTERM the process, kill
 * its tmux session, and drop the session record so `apiary ps` stops listing a
 * corpse.
 *
 * A record whose pid is dead is still cleaned up — that is the difference
 * between "this agent is remote, leave it alone" and "this agent already died
 * and left its paperwork behind", and only the first should stay on disk.
 */
export function terminateLocalAgent(
  agentName: string,
  deps: TerminateDeps = {},
): TerminateOutcome {
  const list = deps.list ?? listAgentSessions;
  const alive = deps.alive ?? isAgentAlive;
  const kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const clear = deps.clear ?? clearAgentSession;

  for (const runtime of RUNTIMES) {
    const session = list(runtime).find((s) => s.agentName === agentName);
    if (!session) continue;

    if (!alive(session)) {
      // The record outlived the process. Clear it so the name is free.
      clear(runtime, agentName);
      return { stopped: false, reason: "already-exited" };
    }

    try { kill(session.pid, "SIGTERM"); } catch { /* raced with its own exit */ }
    if (session.tmuxSession && deps.killTmux) {
      try { deps.killTmux(session.tmuxSession); } catch { /* already gone */ }
    }
    clear(runtime, agentName);
    return {
      stopped: true,
      runtime,
      pid: session.pid,
      tmuxSession: session.tmuxSession ?? "",
    };
  }

  return { stopped: false, reason: "not-local" };
}

// ── Duplicate seats ─────────────────────────────────────────────────────────

/** The subset of a connected participant this decision needs. */
export interface SeatSummary {
  id: string;
  name: string;
  type: "human" | "agent";
}

/**
 * Which existing seats a joining participant should evict.
 *
 * An agent runtime that rejoins — after an SSE drop, a reconnect, or a second
 * `join_room` call — used to be handed a brand new seat while its old one
 * stayed in the roster. Two participants then answered to one name, and every
 * lookup that resolves a name had to pick between them without any of them
 * agreeing which to pick. Observed: an `@aztraboy` mention routed to the dead
 * seat so the live agent never received the message, and `/kick aztraboy`
 * removed the LIVE agent and left the corpse in the room.
 *
 * Only agents are reclaimed. Two people may legitimately share a display name
 * — they are different humans and both should be in the room — whereas one
 * agent name is one runtime by construction, so a second seat under it is
 * always the ghost of the first.
 */
export function seatsToEvict(
  seats: readonly SeatSummary[],
  joining: { name: string; type: "human" | "agent" },
): SeatSummary[] {
  if (joining.type !== "agent") return [];
  return seats.filter((s) => s.type === "agent" && s.name === joining.name);
}
