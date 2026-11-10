/**
 * Remember an `apiary mcp` session's rooms across a restart of the session.
 *
 * A restarted Claude Code session starts a fresh `apiary mcp` with no rooms,
 * so the agent silently left every room until someone pasted join_room
 * again. Each successful join is now recorded under the agent's identity —
 * its tmux pane (session:window.pane, stable across a restart in that pane)
 * or, outside tmux, its working directory — and on startup those rooms are
 * joined again under the same name, so the server replaces the old seat.
 *
 * The record lives in ~/.apiary/mcp-rooms/<key>.json, mode 0600 — next to
 * the room session files that already hold these tokens. It is removed for a
 * room on leave_room, on a kick, and when the room rejects the link for good.
 * Restoring uses the same fallbacks as a live re-join: the same-tier token the
 * room's local session file now holds (after a server restart), and that
 * file's 127.0.0.1 / localhost address. A room that answers on none of them is
 * skipped with a stderr line and a note in the next catch_up.
 *
 * `APIARY_MCP_REMEMBER=off` turns it off. Under a test runner it is off unless
 * `APIARY_MCP_REMEMBER=on`, so tests never share rooms through it.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JoinRoomResult } from "../../agent/mcp/runtime.js";
import type { JoinResult } from "../runtime-handlers.js";
import { isLoopbackUrl, readLocalRoomSession, type LocalRoomSession } from "../rejoin.js";

export interface RememberedRoom {
  /** The room's name on the server (the key). */
  roomName: string;
  /** The agent's local alias, when it joined under one. */
  alias?: string;
  /** The share URL join_room was given (token stripped; see shareToken). */
  joinUrl: string;
  /** The share token currently in use (refreshed after a server restart). */
  shareToken?: string;
  /** Set when the token was one of the room's own: the tier, for a same-tier refresh. */
  localTier?: "admin" | "member";
  name: string;
  type: "agent";
  savedAt: string;
}

export interface RememberConfig {
  enabled: boolean;
  reason?: string;
}

export function resolveRememberConfig(env: NodeJS.ProcessEnv): RememberConfig {
  const setting = (env.APIARY_MCP_REMEMBER ?? "").trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") {
    return { enabled: false, reason: "APIARY_MCP_REMEMBER=off" };
  }
  if ((env.VITEST || env.NODE_ENV === "test") && setting !== "on") {
    return { enabled: false, reason: "running under a test runner (APIARY_MCP_REMEMBER=on to opt in)" };
  }
  return { enabled: true };
}

/** Ask tmux which session, window and pane $TMUX_PANE is. */
function tmuxPanePosition(pane: string): string | null {
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#S:#I.#P"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Who this agent is, stably across a restart of its session: its tmux pane
 * position when there is one, else its working directory.
 */
export function memoryKey(
  env: NodeJS.ProcessEnv,
  cwd: string,
  lookupPane: (pane: string) => string | null = tmuxPanePosition,
): string {
  const pane = env.TMUX_PANE?.trim();
  if (pane && /^%\d+$/.test(pane)) {
    const pos = lookupPane(pane);
    if (pos) return `tmux-${pos.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`;
  }
  return `cwd-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
}

export function memoryPath(key: string): string {
  return join(homedir(), ".apiary", "mcp-rooms", `${key}.json`);
}

function stripToken(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return url;
  }
}

function withToken(url: string, token: string | undefined): string {
  try {
    const u = new URL(url);
    if (token) u.searchParams.set("token", token);
    return u.toString();
  } catch {
    return url;
  }
}

export class RoomMemory {
  constructor(readonly file: string) {}

  list(): RememberedRoom[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf-8")) as { rooms?: RememberedRoom[] };
      return Array.isArray(data.rooms)
        ? data.rooms.filter((r) => r && typeof r.roomName === "string" && typeof r.joinUrl === "string" && typeof r.name === "string")
        : [];
    } catch {
      return [];
    }
  }

  /** Record (or refresh) a joined room. */
  remember(jr: JoinResult): void {
    const roomName = jr.rejoin.serverRoomName || jr.roomName;
    const entry: RememberedRoom = {
      roomName,
      alias: jr.roomName !== roomName ? jr.roomName : undefined,
      joinUrl: stripToken(jr.rejoin.joinUrl),
      shareToken: jr.rejoin.shareToken,
      localTier: jr.rejoin.localTier,
      name: jr.rejoin.name,
      type: "agent",
      savedAt: new Date().toISOString(),
    };
    this.write([...this.list().filter((r) => r.roomName !== roomName), entry]);
  }

  forget(roomName: string): void {
    const rooms = this.list();
    const kept = rooms.filter((r) => r.roomName !== roomName);
    if (kept.length !== rooms.length) this.write(kept);
  }

  private write(rooms: RememberedRoom[]): void {
    const dir = join(this.file, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, rooms }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export interface RestoreDeps {
  join: (url: string, alias: string | undefined, name: string) => Promise<JoinRoomResult>;
  forget: (roomName: string) => void;
  log: (line: string) => void;
  readRoomSession?: (roomName: string) => LocalRoomSession | null;
}

/** The addresses and tokens to try for one remembered room, best first. */
export function restoreCandidates(room: RememberedRoom, session: LocalRoomSession | null): string[] {
  const urls = [withToken(room.joinUrl, room.shareToken)];
  const local = session?.serverUrl && isLoopbackUrl(session.serverUrl) ? session.serverUrl.replace(/\/$/, "") : undefined;
  if (local) {
    const fresh = room.localTier === "admin" ? session?.adminToken
      : room.localTier === "member" ? session?.memberToken
      : undefined;
    // After a server restart the room's own tokens are new. Same tier only.
    if (fresh && fresh !== room.shareToken) urls.push(withToken(`${local}/`, fresh));
    urls.push(withToken(`${local}/`, room.shareToken));
  }
  return [...new Set(urls)];
}

/**
 * Join every remembered room again. Returns one note per room for the next
 * catch_up: which rooms are back, and which were skipped and why.
 */
export async function restoreRooms(rooms: RememberedRoom[], deps: RestoreDeps): Promise<string[]> {
  const notes: string[] = [];
  const read = deps.readRoomSession ?? readLocalRoomSession;
  for (const room of rooms) {
    let lastError = "";
    let rejected = false;
    let back = false;
    for (const url of restoreCandidates(room, read(room.roomName))) {
      const r = await deps.join(url, room.alias, room.name);
      if (r.success) {
        back = true;
        break;
      }
      lastError = r.error ?? "unknown error";
      if (/invalid share token/i.test(lastError)) rejected = true;
    }
    const label = `"${room.alias ?? room.roomName}"`;
    if (back) {
      deps.log(`rejoined room ${label} from the last session as "${room.name}"`);
      notes.push(`Rejoined room ${label} from your last session, as "${room.name}".`);
      continue;
    }
    if (rejected) {
      // The room no longer accepts this link: it was recreated or the link revoked.
      deps.forget(room.roomName);
      deps.log(`room ${label} from the last session no longer accepts its link; forgotten`);
      notes.push(`Room ${label} from your last session no longer accepts its share link — ask for a new one and call join_room.`);
    } else {
      deps.log(`room ${label} from the last session is unreachable; skipped (${lastError.slice(0, 120)})`);
      notes.push(`Room ${label} from your last session did not answer, so you are not in it. Call join_room when it is back.`);
    }
  }
  return notes;
}
