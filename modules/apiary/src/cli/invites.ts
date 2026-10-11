/**
 * Invite queue — bridge between `apiary room create` (writer) and the agent
 * runtimes (reader).
 *
 * When the wizard background-spawns an agent, it stashes the room's join URL
 * at ~/.apiary/invites/<agentName>. On startup the agent runtime reads that
 * file and asks the LLM to call `join_room(url)`, so the agent shows up in the
 * room without the user having to paste anything.
 *
 * The invite is only *cleared* once the agent has actually joined. A CLI that
 * boots into a login screen, an onboarding prompt or a crash has not consumed
 * anything, and deleting the file there strands the agent outside the room with
 * nothing left to retry from — the URL is gone and `room resume` has no invite
 * to hand back. Read with `peekInvite`, delete with `clearInvite`, and let
 * `deliverInvite` sequence the two.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { INVITES_DIR } from "./serve.js";
import type { ContentPart } from "../agent/types.js";

/** Read the queued invite for an agent without removing it. Returns the join URL, or null. */
export function peekInvite(agentName: string): string | null {
  const path = pathJoin(INVITES_DIR, agentName);
  if (!existsSync(path)) return null;
  try {
    const url = readFileSync(path, "utf-8").trim();
    return url || null;
  } catch {
    return null;
  }
}

/** Remove the queued invite for an agent. Never throws. */
export function clearInvite(agentName: string): void {
  try {
    unlinkSync(pathJoin(INVITES_DIR, agentName));
  } catch {
    /* already gone */
  }
}

/** Read and remove the queued invite in one step. Returns the join URL, or null. */
export function consumeInvite(agentName: string): string | null {
  const url = peekInvite(agentName);
  if (url !== null) clearInvite(agentName);
  return url;
}

/**
 * True if two URLs point at the same apiary server.
 *
 * Used to tell "the agent joined the room it was invited to" from "the agent
 * joined some other room". Falls back to `true` on an unparseable URL: an
 * over-eager clear costs one un-auto-joined agent, whereas never clearing
 * leaves the runtime pestering an agent that is already in the room.
 */
export function sameApiaryServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return true;
  }
}

/** The prompt handed to the agent so it joins the room it was invited to. */
export function invitePrompt(url: string): ContentPart[] {
  return [{
    type: "text",
    text: `Please join the apiary room you were invited to by calling the join_room tool with this URL: ${url}`,
  }];
}

export interface DeliverInviteOptions {
  agentName: string;
  /** Push the prompt at the agent (the runtime's tmux bridge / stdout writer). */
  deliver: (parts: ContentPart[]) => Promise<void> | void;
  /**
   * True once the agent is actually in the invited room — the only success
   * signal that counts. Receives the invite URL so the caller can tell the
   * invited room from some other room the agent joined on its own.
   */
  hasJoined: (inviteUrl: string) => boolean;
  /** How many times to hand the agent the invite. Default: 6. */
  maxAttempts?: number;
  /** Gap between attempts, also the post-delivery grace period (ms). Default: 20_000. */
  retryIntervalMs?: number;
  /** Cooperative cancellation — checked between polls. */
  signal?: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type DeliverInviteOutcome =
  | "no-invite"      // nothing queued for this agent
  | "joined"         // agent joined; invite cleared
  | "abandoned"      // attempts exhausted; invite left on disk for the next launch
  | "cancelled";     // runtime shut down mid-delivery; invite left on disk

const POLL_STEP_MS = 500;

/**
 * Hand an agent its queued invite and keep at it until the agent is really in
 * the room, then clear the invite.
 *
 * On give-up the invite file is deliberately left in place: the next
 * `apiary room resume` (or a manual relaunch) picks it straight back up, which
 * is the difference between "the agent was slow to boot" and "the agent is
 * permanently locked out of the room".
 */
export async function deliverInvite(opts: DeliverInviteOptions): Promise<DeliverInviteOutcome> {
  const {
    agentName,
    deliver,
    hasJoined,
    maxAttempts = 6,
    retryIntervalMs = 20_000,
    signal,
    // unref'd: a pending retry must never be the reason the process stays up.
    sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }),
  } = opts;

  const url = peekInvite(agentName);
  if (url === null) return "no-invite";

  // Already in a room (a resumed session, say) — nothing to ask for.
  if (hasJoined(url)) {
    clearInvite(agentName);
    return "joined";
  }

  const parts = invitePrompt(url);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return "cancelled";

    try {
      await deliver(parts);
    } catch {
      /* delivery is best-effort — a wedged pane still gets the next attempt */
    }

    // Poll in short steps so a join is noticed promptly and a shutdown isn't
    // stuck waiting out the full retry interval. Counted rather than
    // wall-clocked, so an injected instant `sleep` cannot spin hot.
    const steps = Math.max(1, Math.ceil(retryIntervalMs / POLL_STEP_MS));
    for (let step = 0; step < steps; step++) {
      if (signal?.aborted) return "cancelled";
      if (hasJoined(url)) {
        clearInvite(agentName);
        return "joined";
      }
      await sleep(POLL_STEP_MS);
    }
  }

  if (signal?.aborted) return "cancelled";
  if (hasJoined(url)) {
    clearInvite(agentName);
    return "joined";
  }

  return "abandoned";
}
