/**
 * apiary join — connect to a room as a human participant.
 *
 * Opens the TUI and connects to a apiary server over HTTP.
 * Events stream in via SSE, messages sent via POST /message.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { randomName } from "../core/names.js";
import { loadConfig, saveConfig, roomEmoji } from "./config.js";
import type { RoomEvent } from "../core/events.js";
import type { AuthorityLevel } from "../core/types.js";
import { formatTimestamp as formatTimestampUTC } from "../agent/prompts.js";

/** Format a Date as local HH:MM:SS for TUI display. */
function formatTimestamp(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
import { startTUI, type TUIHandle, type DisplayEvent } from "./tui.js";
import { extractToken, buildShareUrl } from "./auth.js";
import { can } from "../core/authority.js";

export interface JoinOptions {
  server: string;
  name?: string;
  guest?: boolean;
  /** Share URL to display before TUI starts (for host+join mode with --share). */
  shareUrl?: string;
  /** Skip TUI — stream events as JSON to stdout, read messages from stdin. */
  headless?: boolean;
  /** Agent names the wizard spawned but who haven't connected yet. Shown as
   *  `⏳ booting` in the footer until ParticipantJoined fires for each, then
   *  flips to `⚠ stalled` after 30s if they never show up. */
  expectedAgents?: string[];
}

export async function join(options: JoinOptions): Promise<void> {
  // Extract token from URL if present
  const token = extractToken(options.server);
  // Strip query params to get clean server URL
  let serverUrl: string;
  try {
    const parsed = new URL(options.server);
    parsed.search = "";
    serverUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    serverUrl = options.server.replace(/\/$/, "");
  }

  const name = options.name ?? randomName();
  const isGuest = options.guest ?? false;

  // ── Register with server ────────────────────────────────────────────────

  let sessionToken: string;
  let participantId: string;
  let roomName: string;
  let authority: AuthorityLevel;
  let participants: Array<{ id: string; name: string; type: string; authority?: string }>;

  try {
    const joinBody: Record<string, unknown> = {};
    if (token) {
      joinBody.token = token;
      joinBody.type = "human";
      joinBody.name = name;
    } else if (isGuest) {
      joinBody.type = "guest";
    } else {
      joinBody.type = "human";
      joinBody.name = name;
    }

    const res = await fetch(`${serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(joinBody),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Failed to join: ${err}`);
      process.exit(1);
    }

    const data = await res.json() as Record<string, unknown>;
    sessionToken = String(data.sessionToken ?? "");
    participantId = String(data.participantId);
    roomName = String(data.roomName);
    authority = (data.authority as AuthorityLevel) ?? "member";
    participants = (data.participants as Array<{ id: string; name: string; type: string; authority?: string }>) ?? [];
  } catch (err) {
    console.error(`Cannot reach apiary server at ${serverUrl}. Is it running?`);
    console.error(`  Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // ── Disconnect helper ───────────────────────────────────────────────────

  let disconnected = false;
  let cleanupStream: (() => void) | null = null;
  const disconnect = async () => {
    if (disconnected) return;
    disconnected = true;
    cleanupStream?.();
    try {
      await fetch(`${serverUrl}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({}),
      });
    } catch {
      // Server may be down
    }
  };

  // ── Headless mode — skip TUI, stream events as JSON, read messages from stdin ──

  if (options.headless) {
    const sseController = new AbortController();
    const cleanup = async () => {
      sseController.abort();
      await disconnect();
    };

    process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

    // Read messages from stdin and send them
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", async (line) => {
      const content = line.trim();
      if (!content || authority === "guest") return;
      try {
        await fetch(`${serverUrl}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ content }),
        });
      } catch { /* server may be down */ }
    });

    // Stream events from SSE and write as JSON lines to stdout
    try {
      const res = await fetch(`${serverUrl}/events`, {
        method: "POST",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${sessionToken}` },
        signal: sseController.signal,
      });

      if (!res.ok || !res.body) {
        process.stderr.write("Failed to connect event stream\n");
        await cleanup();
        process.exit(1);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop()!;
        for (const part of parts) {
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            process.stdout.write(JSON.stringify(event) + "\n");
          } catch { /* malformed */ }
        }
      }
    } catch {
      // Stream ended or aborted
    }

    if (!disconnected) { await cleanup(); }
    process.exit(0);
  }

  // ── Start TUI ───────────────────────────────────────────────────────────

  const isReadOnly = authority === "guest" || isGuest;

  // ── Slash command helper ──────────────────────────────────────────────

  function systemEvent(content: string): void {
    tui.push({
      id: randomUUID(),
      ts: formatTimestamp(new Date()),
      kind: "system",
      content,
    });
  }

  async function handleSlashCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      // ── /help ─────────────────────────────────────────────────────
      case "help": {
        const lines = [
          "/who              list participants",
          "/ping <name>      ping for a status check",
          "/peek <name>      show how to view an agent's tmux session",
          "/share            generate share links",
          "/sound            toggle notification sounds",
          "/leave            disconnect",
        ];
        if (authority === "product_owner") {
          lines.push(
            "",
            "/mute <name>      demote to guest",
            "/unmute <name>    restore to member",
            "/setmode <n> <m>  set engagement mode",
          );
        }
        if (authority === "admin") {
          lines.push(
            "",
            "/promote <name>   promote to product owner",
            "/demote <name>    demote to member",
            "/kick <name>      remove a participant",
            "/mute <name>      demote to guest",
            "/unmute <name>    restore to member",
            "/setmode <n> <m>  set engagement mode",
            "/clear            wipe room history",
            "/tunnel           start cloudflared tunnel",
          );
        }
        systemEvent(lines.join("\n"));
        return;
      }

      // ── /who ──────────────────────────────────────────────────────
      case "who": {
        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string; type: string; authority?: string }> };
          const lines = data.participants.map((p) => {
            const auth = p.authority ?? "member";
            const label = auth === "product_owner" ? "owner" : auth;
            return `  ${p.type === "agent" ? "agent" : "human"} ${p.name} (${label})`;
          });
          systemEvent(`Participants:\n${lines.join("\n")}`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /peek ─────────────────────────────────────────────────────
      // Print the tmux command to view an agent's Claude Code/Codex session.
      // Doesn't switch terminals (that would fight ink's render loop) — the
      // user runs it themselves after detaching from apiary (Ctrl+C).
      case "peek": {
        const name = args[0];
        if (!name) { systemEvent("Usage: /peek <name>"); return; }
        systemEvent(
          `Peek at ${name}:\n` +
          `  1. Ctrl+C to leave apiary (server keeps running)\n` +
          `  2. tmux attach -t apiary_${name}\n` +
          `  3. Ctrl+B then D to detach from the agent\n` +
          `  4. apiary room resume <room>  to come back`,
        );
        return;
      }

      // ── /rules ────────────────────────────────────────────────────
      // Read-only display of the room's current rules. Any participant
      // (including guests) can view.
      case "rules": {
        try {
          const res = await fetch(`${serverUrl}/rules`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to fetch rules."); return; }
          const data = (await res.json()) as { rules: string[] };
          if (data.rules.length === 0) {
            systemEvent("No rules set for this room.");
            return;
          }
          const lines = ["Room rules:"];
          data.rules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
          systemEvent(lines.join("\n"));
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /leave ────────────────────────────────────────────────────
      case "leave": {
        await disconnect();
        tui.stop();
        process.exit(0);
        return;
      }

      // ── /kick <name> (admin only) ─────────────────────────────────
      case "kick": {
        if (!can(authority, "kick")) { systemEvent("Only admins can kick."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /kick <name>"); return; }

        // Look up participant by name
        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const kickRes = await fetch(`${serverUrl}/kick`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id }),
          });
          if (!kickRes.ok) { systemEvent(`Failed to kick: ${await kickRes.text()}`); return; }
          systemEvent(`Kicked ${targetName}.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /mute <name> (admin or product_owner) — demote to guest ─────
      case "mute": {
        if (!can(authority, "mute")) { systemEvent("Only admins and product owners can mute."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /mute <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const authRes = await fetch(`${serverUrl}/set-authority`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id, authority: "guest" }),
          });
          if (!authRes.ok) { systemEvent(`Failed to mute: ${await authRes.text()}`); return; }
          systemEvent(`Muted ${targetName} (guest).`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /unmute <name> (admin or product_owner) — restore to member ──
      case "unmute": {
        if (!can(authority, "unmute")) { systemEvent("Only admins and product owners can unmute."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /unmute <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const authRes = await fetch(`${serverUrl}/set-authority`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id, authority: "member" }),
          });
          if (!authRes.ok) { systemEvent(`Failed to unmute: ${await authRes.text()}`); return; }
          systemEvent(`Unmuted ${targetName} (member).`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /setmode <name> <mode> (admin or product_owner) ──────────
      case "setmode": {
        if (!can(authority, "set_mode_for")) { systemEvent("Only admins and product owners can set modes."); return; }
        const targetName = args[0];
        const mode = args[1];
        if (!targetName || !mode) { systemEvent("Usage: /setmode <name> <mode>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const modeRes = await fetch(`${serverUrl}/set-mode`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id, mode }),
          });
          if (!modeRes.ok) { systemEvent(`Failed to set mode: ${await modeRes.text()}`); return; }
          systemEvent(`Set ${targetName} to ${mode}.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /promote <name> (admin only) — elevate to product_owner ──
      case "promote": {
        if (!can(authority, "promote")) { systemEvent("Only admins can promote."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /promote <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const authRes = await fetch(`${serverUrl}/set-authority`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id, authority: "product_owner" }),
          });
          if (!authRes.ok) { systemEvent(`Failed to promote: ${await authRes.text()}`); return; }
          systemEvent(`${targetName} is now a product owner.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /demote <name> (admin only) — restore product_owner to member ──
      case "demote": {
        if (!can(authority, "demote")) { systemEvent("Only admins can demote."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /demote <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const authRes = await fetch(`${serverUrl}/set-authority`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id, authority: "member" }),
          });
          if (!authRes.ok) { systemEvent(`Failed to demote: ${await authRes.text()}`); return; }
          systemEvent(`${targetName} is now a member.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /ping <name> ─────────────────────────────────────────────
      case "ping": {
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /ping <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const pingRes = await fetch(`${serverUrl}/ping`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ participantId: target.id }),
          });
          if (!pingRes.ok) { systemEvent(`Failed to ping: ${await pingRes.text()}`); return; }
          systemEvent(`Pinged ${targetName}.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /share [--as <tier>] ──────────────────────────────────────
      case "share": {
        if (authority === "guest") { systemEvent("Guests cannot create share links."); return; }

        let targetAuthority: string | undefined;
        if (args[0] === "--as" && args[1]) {
          targetAuthority = args[1];
        }

        try {
          const shareBody: Record<string, unknown> = {};
          if (targetAuthority) shareBody.authority = targetAuthority;

          const res = await fetch(`${serverUrl}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify(shareBody),
          });
          if (!res.ok) { systemEvent(`Failed: ${await res.text()}`); return; }
          const data = (await res.json()) as { links: Record<string, string> };
          const lines = Object.entries(data.links).map(([tier, url]) =>
            `  ${tier}: apiary join ${url}`
          );
          systemEvent(`Share links:\n${lines.join("\n")}`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /sound — toggle notification sounds ───────────────────────
      case "sound": {
        const enabled = tui.toggleSound();
        const cfg = loadConfig();
        cfg.sound = enabled;
        saveConfig(cfg);
        systemEvent(`Sound ${enabled ? "on" : "off"} (saved for future rooms).`);
        return;
      }

      // ── /clear — wipe room history (admin only) ─────────────────
      case "clear": {
        if (!can(authority, "clear_history")) { systemEvent("Only admins can clear."); return; }

        try {
          const res = await fetch(`${serverUrl}/clear`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          });
          if (!res.ok) { systemEvent(`Failed to clear: ${await res.text()}`); return; }
          // Server broadcasts RoomCleared — TUI clear happens in SSE handler
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /tunnel — start cloudflared tunnel mid-session ────────────
      case "tunnel": {
        if (!can(authority, "start_tunnel")) { systemEvent("Only admins can start tunnels."); return; }

        try {
          const res = await fetch(`${serverUrl}/tunnel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          });
          if (!res.ok) { systemEvent(`Failed: ${(await res.json() as { error: string }).error}`); return; }
          const data = (await res.json()) as { url: string; alreadyRunning: boolean };
          if (data.alreadyRunning) {
            systemEvent(`Tunnel already running: ${data.url}`);
          } else {
            systemEvent(`Tunnel started: ${data.url}\nUse /share to generate share links.`);
          }
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      default:
        systemEvent(`Unknown command: /${cmd}`);
    }
  }

  // Set terminal tab title — hive emoji stable per (room, name) pair.
  process.stdout.write(`\x1b]0;${roomEmoji(`${roomName}·${name}`)} ${roomName} · ${name}\x07`);

  // Print share info before Ink renders — plain text, fully selectable.
  if (options.shareUrl) {
    console.log();
    console.log(`  \x1b[2mShare:\x1b[0m \x1b[33m${options.shareUrl}\x1b[0m`);
    console.log();
    console.log(`  \x1b[2mJoin:\x1b[0m   \x1b[36mapiary join\x1b[0m \x1b[2m<url>\x1b[0m`);
    console.log(`  \x1b[2mAgent:\x1b[0m  \x1b[36mapiary claude\x1b[0m \x1b[2m<name>  → tell it the URL, it joins\x1b[0m`);
    console.log();
  }

  const config = loadConfig();
  const tui = startTUI({
    roomName,
    readOnly: isReadOnly,
    authority,
    soundEnabled: config.sound ?? true,
    onSend: isReadOnly ? undefined : async (content: string) => {
      // Intercept slash commands
      if (content.startsWith("/")) {
        await handleSlashCommand(content);
        return;
      }

      try {
        await fetch(`${serverUrl}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ content }),
        });
      } catch {
        // Server may be down — silently fail
      }
    },
    onCtrlC: async () => {
      await disconnect();
      tui.stop();
      process.exit(0);
    },
  });

  // Welcome note
  if (!isReadOnly) {
    const hint = authority === "admin" ? "/help for commands (admin)" : "/help for commands";
    systemEvent(hint);
  }

  // Set initial agent names + participant names
  const agentNames = participants
    .filter((p) => p.type === "agent")
    .map((p) => p.name);

  // Seed any wizard-spawned-but-not-yet-joined agents as `pending` so the
  // footer shows them booting instead of staying empty for 5–15s. The set
  // is mutated (drained) as ParticipantJoined events arrive, and merged
  // into setAgentNames calls so they don't get clobbered.
  const pendingAgentSet = new Set(
    (options.expectedAgents ?? []).filter((n) => !agentNames.includes(n)),
  );
  const renderAgentList = (joined: Iterable<string>): void => {
    const merged = new Set<string>([...joined, ...pendingAgentSet]);
    tui.setAgentNames([...merged]);
  };
  if (agentNames.length + pendingAgentSet.size > 0) {
    renderAgentList(agentNames);
    for (const n of pendingAgentSet) tui.setAgentState(n, "pending");
  }
  if (agentNames.length > 0) {

    // Determine initial agent state from recent messages.
    //
    // Walk newest-first to find the most recent human message:
    //   - If older than INIT_FRESHNESS_MS → leave everyone "unknown" (don't fabricate
    //     a busy/idle signal from stale context).
    //   - Otherwise: agents that replied after that human message are idle.
    //     Agents that didn't reply: if the human message was a whisper, only its
    //     recipients are working; otherwise all silent agents are working.
    const INIT_FRESHNESS_MS = 5 * 60_000;
    try {
      const msgRes = await fetch(`${serverUrl}/messages?count=20`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (msgRes.ok) {
        const { items: messages } = (await msgRes.json()) as {
          items: Array<{
            sender_id: string;
            sender_name: string;
            timestamp?: string;
            recipients?: string[];
          }>;
        };
        const agentSet = new Set(agentNames);
        const idleAgents = new Set<string>();
        let humanMsg: typeof messages[0] | null = null;
        for (const msg of messages) {
          const sType = participants.find((p) => p.id === msg.sender_id)?.type;
          if (sType === "agent" && agentSet.has(msg.sender_name)) {
            idleAgents.add(msg.sender_name);
          } else if (sType === "human") {
            humanMsg = msg;
            break;
          }
        }
        const fresh = humanMsg?.timestamp
          ? (Date.now() - new Date(humanMsg.timestamp).getTime()) < INIT_FRESHNESS_MS
          : false;
        if (humanMsg && fresh) {
          // Whisper? Only its recipients are candidates for "working".
          const targetedAgents: Set<string> = humanMsg.recipients && humanMsg.recipients.length > 0
            ? new Set(
                participants
                  .filter((p) => p.type === "agent" && humanMsg!.recipients!.includes(p.id))
                  .map((p) => p.name),
              )
            : agentSet;
          for (const agent of agentSet) {
            if (idleAgents.has(agent)) {
              tui.setAgentState(agent, "idle");
            } else if (targetedAgents.has(agent)) {
              tui.setAgentState(agent, "working");
            }
            // else: leave at default "unknown" — agent wasn't addressed
          }
        }
        // Stale or no human message → leave everyone at "unknown" default
      }
    } catch { /* non-critical — default to no indicator */ }
  }
  const participantNames = new Set(
    participants.filter((p) => p.id !== participantId).map((p) => p.name),
  );
  tui.setParticipants([...participantNames]);

  // ── Connect SSE event stream ────────────────────────────────────────────
  // ⚠️  MUST use POST — DO NOT change to GET.
  // Cloudflare Quick Tunnels buffer GET streaming responses and only flush
  // when the connection closes. POST streams in real-time. (cloudflared#1449)
  // https://github.com/cloudflare/cloudflared/issues/1449

  {
    const participantTypes = new Map<string, "human" | "agent">();
    const participantNameById = new Map<string, string>();
    for (const p of participants) {
      participantTypes.set(p.id, p.type as "human" | "agent");
      participantNameById.set(p.id, p.name);
    }
    const currentAgents = new Set(agentNames);
    const PING_DECAY_MS = 10_000; // pings are status checks — much shorter
    let sseController: AbortController | null = null;

    cleanupStream = () => {
      if (sseController) { sseController.abort(); sseController = null; }
    };

    const connectSSE = async () => {
      sseController = new AbortController();

      try {
        const res = await fetch(`${serverUrl}/events`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${sessionToken}`,
          },
          signal: sseController.signal,
        });

        if (!res.ok || !res.body) {
          console.error("Failed to connect event stream");
          await disconnect();
          process.exit(1);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!;

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as RoomEvent & { _replyToName?: string };

              // Handle room clear — wipe TUI and show system message
              if (event.type === "RoomCleared") {
                tui.clear();
                systemEvent(`Room cleared by ${(event as any).cleared_by ?? "admin"}.`);
                continue;
              }

              if (event.type === "ParticipantJoined") {
                participantTypes.set(event.participant.id, event.participant.type);
              }

              const displayEvent = toDisplayEvent(event, participantId, participantTypes);
              if (displayEvent) {
                tui.push(displayEvent);
              }

              if (event.type === "ParticipantJoined") {
                participantNameById.set(event.participant.id, event.participant.name);
                if (event.participant.type === "agent") {
                  currentAgents.add(event.participant.name);
                  // Drain from pending — agent we were waiting on has arrived.
                  pendingAgentSet.delete(event.participant.name);
                  renderAgentList(currentAgents);
                  // A fresh agent that just connected — assume idle until proven otherwise.
                  tui.setAgentState(event.participant.name, "idle");
                }
                if (event.participant.id !== participantId) {
                  participantNames.add(event.participant.name);
                  tui.setParticipants([...participantNames]);
                }
              }

              // ── Agent state transitions ───────────────────────────────────
              if (event.type === "MessageSent") {
                const senderType = participantTypes.get(event.message.sender_id);
                if (senderType === "agent" && currentAgents.has(event.message.sender_name)) {
                  // The agent spoke — definitively idle.
                  tui.setAgentState(event.message.sender_name, "idle");
                } else if (senderType === "human") {
                  // Whisper-aware: only mark agents addressed by this message as working.
                  const recipients = (event.message as { recipients?: string[] }).recipients ?? [];
                  if (recipients.length > 0) {
                    // Whisper — only resolve recipients that are agents we know.
                    for (const recipientId of recipients) {
                      const name = participantNameById.get(recipientId);
                      if (name && currentAgents.has(name)) {
                        tui.setAgentState(name, "working");
                      }
                    }
                  } else {
                    // Public message — every agent is a candidate (engagement-unknown from here).
                    for (const agent of currentAgents) tui.setAgentState(agent, "working");
                  }
                }
              }
              if (event.type === "Pinged") {
                // Pings are status checks, not real work — short decay.
                const pinged = event as RoomEvent & { participant_id?: string };
                if (pinged.participant_id) {
                  const name = participantNameById.get(pinged.participant_id);
                  if (name && currentAgents.has(name)) {
                    tui.setAgentState(name, "working", { decayMs: PING_DECAY_MS });
                  }
                }
              }
              if (event.type === "StatusChanged") {
                // Server-driven presence. Use it as the source of truth for unresponsive/offline.
                const sc = event as RoomEvent & {
                  name: string;
                  status: "online" | "unresponsive" | "offline";
                  previous_status: "online" | "unresponsive" | "offline";
                };
                if (currentAgents.has(sc.name)) {
                  if (sc.status === "unresponsive") {
                    tui.setAgentState(sc.name, "unresponsive");
                  } else if (sc.status === "online" && sc.previous_status === "unresponsive") {
                    // Recovered — assume idle until next signal.
                    tui.setAgentState(sc.name, "idle");
                  }
                  // status === "offline" is followed by ParticipantLeft/Kicked, handled below.
                }
              }

              if (event.type === "ParticipantLeft" || event.type === "ParticipantKicked") {
                if (event.participant.type === "agent") {
                  currentAgents.delete(event.participant.name);
                  renderAgentList(currentAgents);
                }
                participantTypes.delete(event.participant.id);
                participantNameById.delete(event.participant.id);
                participantNames.delete(event.participant.name);
                tui.setParticipants([...participantNames]);
              }
            } catch {
              // Malformed event — skip
            }
          }
        }

        // Stream ended — server closed connection
        if (!disconnected) {
          tui.stop();
          console.log("\nServer disconnected.");
          process.exit(0);
        }
      } catch {
        if (!disconnected) {
          tui.stop();
          console.log("\nServer disconnected.");
          process.exit(0);
        }
      }
    };

    connectSSE();
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────

  process.on("SIGINT", async () => {
    await disconnect();
    tui.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await disconnect();
    tui.stop();
    process.exit(0);
  });
}

// ── RoomEvent → DisplayEvent conversion ───────────────────────────────────────

function toDisplayEvent(
  event: RoomEvent & { _replyToName?: string },
  selfId: string,
  participantTypes: Map<string, "human" | "agent">,
): DisplayEvent | null {
  const ts = formatTimestamp(new Date(event.timestamp));

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const senderType = participantTypes.get(msg.sender_id) ?? "human";
      return {
        id: msg.id,
        ts,
        kind: "message",
        senderName: msg.sender_name,
        senderType,
        isSelf: msg.sender_id === selfId,
        content: msg.content,
        replyToName: event._replyToName ?? undefined,
      };
    }
    case "ParticipantJoined":
      return {
        id: randomUUID(),
        ts,
        kind: "join",
        name: event.participant.name,
        participantType: event.participant.type,
      };
    case "ParticipantLeft":
      return {
        id: randomUUID(),
        ts,
        kind: "leave",
        name: event.participant.name,
        participantType: event.participant.type,
      };
    case "ParticipantKicked":
      return {
        id: randomUUID(),
        ts,
        kind: "system",
        content: `${event.participant.name} was kicked`,
      };
    case "AuthorityChanged": {
      const name = event.participant.name;
      if (event.new_authority === "guest") {
        return { id: randomUUID(), ts, kind: "system", content: `${name} was muted` };
      }
      if (event.new_authority === "member") {
        return { id: randomUUID(), ts, kind: "system", content: `${name} was unmuted` };
      }
      if (event.new_authority === "product_owner") {
        return { id: randomUUID(), ts, kind: "system", content: `${name} was promoted to product owner` };
      }
      return { id: randomUUID(), ts, kind: "system", content: `${name} → ${event.new_authority}` };
    }
    case "Pinged":
      return {
        id: randomUUID(),
        ts,
        kind: "ping",
        pingerName: event.pinger_name ?? "someone",
      };
    case "Activity":
      if (event.action === "mode_changed") {
        return {
          id: randomUUID(),
          ts,
          kind: "mode",
          mode: String((event.detail as Record<string, unknown>)?.mode ?? ""),
        };
      }
      return null;
    default:
      return null;
  }
}
