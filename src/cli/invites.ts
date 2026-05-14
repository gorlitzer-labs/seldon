/**
 * Invite queue — bridge between `apiary room create` (writer) and the agent
 * runtimes (reader).
 *
 * When the wizard background-spawns an agent, it stashes the room's join URL
 * at ~/.apiary/invites/<agentName>. On startup the agent runtime consumes
 * that file and asks the LLM to call `join_room(url)`, so the agent shows up
 * in the room without the user having to paste anything.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { INVITES_DIR } from "./serve.js";

/** Read and remove the queued invite for an agent. Returns the join URL, or null. */
export function consumeInvite(agentName: string): string | null {
  const path = pathJoin(INVITES_DIR, agentName);
  if (!existsSync(path)) return null;
  try {
    const url = readFileSync(path, "utf-8").trim();
    try { unlinkSync(path); } catch { /* ok */ }
    return url || null;
  } catch {
    return null;
  }
}
