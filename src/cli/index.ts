#!/usr/bin/env node

/** apiary CLI — shared rooms for AI agents. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, listRoomSessions } from "./serve.js";
import { join } from "./join.js";
import { runClaude, stopClaude, listClaudeSessions } from "./claude/run.js";
import { runOpencode } from "./opencode/run.js";
import { runCodex } from "./codex/run.js";
import { buildShareUrl } from "./auth.js";
import { printUpdateNotice, checkForUpdate } from "./update.js";

const args = process.argv.slice(2);

function getFlag(name: string, arr: string[] = args): string | undefined {
  const idx = arr.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = arr[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

/** Collect all values for a repeatable flag (e.g. --join url1 --join url2). */
function getAllFlags(name: string, arr: string[] = args): string[] {
  const results: string[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith("--")) {
      results.push(arr[i + 1]);
    }
  }
  return results;
}

function getVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return process.env.npm_package_version ?? "unknown";
  }
}

function printUsage(stream: typeof console.log = console.log): void {
  const color = process.stdout.isTTY;
  const Y = color ? "\x1b[33m" : "";  // yellow
  const C = color ? "\x1b[36m" : "";  // cyan
  const G = color ? "\x1b[32m" : "";  // green
  const D = color ? "\x1b[2m"  : "";  // dim
  const B = color ? "\x1b[1m"  : "";  // bold
  const R = color ? "\x1b[0m"  : "";  // reset

  stream("");
  stream(`  ${Y}${B}apiary${R} ${D}v${getVersion()} — shared rooms for AI agents${R}`);
  stream("");
  stream(`  ${G}${B}Room management${R}  ${D}(interactive — recommended)${R}`);
  stream(`  ${C}apiary room create${R}                                          Create a room + invite participants`);
  stream(`  ${C}apiary room resume ${Y}<name>${R}                                Resume a saved room`);
  stream(`  ${C}apiary room list${R}                                            List saved rooms + participants`);
  stream("");
  stream(`  ${G}${B}Quick room${R}  ${D}(one-liner, Ctrl+C leaves server running)${R}`);
  stream(`  ${C}apiary room ${Y}<name>${R} ${D}[--share]${R}                              Host + join the TUI`);
  stream(`  ${C}apiary join ${Y}<url>${R} ${D}[${Y}<name>${R}${D}] [--guest]${R}                   Join an existing room`);
  stream("");
  stream(`  ${G}${B}Agents${R}`);
  stream(`  ${C}apiary mcp ${Y}<name>${R} ${D}[--admin] [--join ${Y}<url>${R}${D}]${R}                Standalone MCP server ${D}(any client)${R}`);
  stream(`  ${C}apiary claude ${Y}<name>${R} ${D}[--admin]${R}                          Launch Claude Code ${D}(tmux wrapper)${R}`);
  stream(`  ${C}apiary codex ${Y}<name>${R} ${D}[--admin]${R}                           Launch Codex ${D}(tmux wrapper)${R}`);
  stream("");
  stream(`  ${C}apiary ps${R}                                                  List rooms + agents`);
  stream(`  ${C}apiary stop${R} ${D}[${Y}<name>${R}${D} | --all]${R}                              Stop agents`);
  stream(`  ${C}apiary examples${R}                                            Use cases + workflows`);
  stream("");
  stream(`  ${G}${B}Quick start${R}  ${D}(MCP — recommended)${R}`);
  stream(`    ${D}1.${R} Add to ${C}~/.claude/mcp.json${R}  ${D}(or project .mcp.json):${R}`);
  stream(`       ${D}{ "mcpServers": { "apiary": {${R}`);
  stream(`           ${D}"type": "stdio", "command": "npx",${R}`);
  stream(`           ${D}"args": ["apiary", "mcp", "${Y}YourName${R}${D}", "--admin"] } } }${R}`);
  stream(`    ${D}2.${R} ${C}apiary room create${R}  ${D}→ follow the prompts${R}`);
  stream(`    ${D}3.${R} ${D}Agents get invited automatically — they call join_room() and participate.${R}`);
  stream("");
  stream(`  ${D}tmux wrapper:${R}  ${C}apiary claude ${Y}Expendable3${R} ${D}--admin${R}  ${D}(alternative to MCP)${R}`);
  stream("");
  stream(`  ${D}Presence env vars (server):  APIARY_UNRESPONSIVE_MS  APIARY_OFFLINE_MS  APIARY_PRESENCE_CHECK_MS${R}`);
  stream(`  ${D}Whisper: apiary__send_message(room, msg, null, ["Alice"])   Attachments: [..., null, [{ type: "path", ... }]]${R}`);
  stream("");
}

function printExamples(): void {
  const color = process.stdout.isTTY;
  const Y = color ? "\x1b[33m" : "";
  const C = color ? "\x1b[36m" : "";
  const G = color ? "\x1b[32m" : "";
  const D = color ? "\x1b[2m"  : "";
  const B = color ? "\x1b[1m"  : "";
  const R = color ? "\x1b[0m"  : "";

  console.log("");
  console.log(`  ${Y}${B}apiary examples${R}`);
  console.log("");

  // ── MCP config (primary)
  console.log(`  ${G}${B}MCP setup${R}  ${D}(recommended — add to ~/.claude/mcp.json or project .mcp.json)${R}`);
  console.log(`    ${D}{${R}`);
  console.log(`      ${D}"mcpServers": {${R}`);
  console.log(`        ${D}"apiary": {${R}`);
  console.log(`          ${D}"type": "stdio",${R}`);
  console.log(`          ${D}"command": "npx",${R}`);
  console.log(`          ${D}"args": ["apiary", "mcp", "${Y}YourName${R}${D}", "--admin"]${R}`);
  console.log(`        ${D}}${R}`);
  console.log(`      ${D}}${R}`);
  console.log(`    ${D}}${R}`);
  console.log(`    ${D}Then paste a room URL to any agent — it calls join_room() and participates.${R}`);
  console.log(`    ${D}Events are pull-based via catch_up(). No tmux, no wrapper.${R}`);
  console.log("");

  // ── Start a room
  console.log(`  ${G}${B}Start a room${R}`);
  console.log(`    ${C}apiary room ${Y}brood-box${R}                  ${D}# host + join the TUI${R}`);
  console.log(`    ${C}apiary room ${Y}brood-box Overlord${R}         ${D}# with a display name${R}`);
  console.log(`    ${C}apiary room ${Y}brood-box${R} ${D}--share${R}           ${D}# with a public tunnel URL${R}`);
  console.log(`    ${D}Ctrl+C leaves the server running — rejoin with: apiary room resume <name>${R}`);
  console.log("");

  // ── Remote sharing
  console.log(`  ${G}${B}Share remotely${R}`);
  console.log(`    ${C}apiary room ${Y}brood-box${R} ${D}--share${R}           ${D}# starts a cloudflared tunnel${R}`);
  console.log(`    ${C}apiary join ${Y}<url>${R}                       ${D}# join from another machine${R}`);
  console.log(`    ${C}apiary join ${Y}<url>${R} ${D}--guest${R}              ${D}# watch read-only${R}`);
  console.log("");

  // ── tmux wrapper (alternative)
  console.log(`  ${G}${B}tmux wrapper${R}  ${D}(alternative to MCP)${R}`);
  console.log(`    ${C}apiary claude ${Y}Expendable3${R} ${D}--admin${R}       ${D}# launch Claude Code in tmux${R}`);
  console.log(`    ${C}apiary codex ${Y}CheapLabor${R}                ${D}# launch Codex in tmux${R}`);
  console.log(`    ${D}Tell the agent the room URL — it joins via apiary__join_room.${R}`);
  console.log("");

  // ── TUI commands
  console.log(`  ${G}${B}TUI commands${R}  ${D}(type these in the chat)${R}`);
  console.log(`    ${C}/who${R}              ${D}list participants${R}`);
  console.log(`    ${C}/ping ${Y}<name>${R}      ${D}ping for a status check${R}`);
  console.log(`    ${C}/clear${R}            ${D}wipe room history (admin)${R}`);
  console.log(`    ${C}/kick ${Y}<name>${R}      ${D}remove a participant (admin)${R}`);
  console.log(`    ${C}/mute ${Y}<name>${R}      ${D}demote to read-only (admin)${R}`);
  console.log(`    ${C}/share${R}            ${D}generate share links${R}`);
  console.log(`    ${C}/tunnel${R}           ${D}start a tunnel mid-session (admin)${R}`);
  console.log(`    ${C}/sound${R}            ${D}toggle notification sounds${R}`);
  console.log(`    ${C}/leave${R}            ${D}disconnect${R}`);
  console.log("");

  // ── Messaging features
  console.log(`  ${G}${B}Messaging features${R}  ${D}(MCP tool params)${R}`);
  console.log(`    ${D}Whisper (DM) — visible only to named recipients:${R}`);
  console.log(`    ${C}apiary__send_message(room, content, null, ${Y}["Alice", "Bob"]${R}${C})${R}`);
  console.log(`    ${D}Attachments — attach a local file or uploaded image:${R}`);
  console.log(`    ${C}apiary__send_message(room, content, null, null, ${Y}[{ type: "path", ... }]${R}${C})${R}`);
  console.log(`    ${D}Others see "Alice is whispering" without the content.${R}`);
  console.log("");

  // ── Management
  console.log(`  ${G}${B}Manage sessions${R}`);
  console.log(`    ${C}apiary ps${R}                            ${D}# list rooms + agents (with join links)${R}`);
  console.log(`    ${C}apiary stop ${Y}Expendable3${R}               ${D}# stop one agent${R}`);
  console.log(`    ${C}apiary stop ${D}--all${R}                     ${D}# stop everything${R}`);
  console.log("");
}

async function main(): Promise<void> {
  // ── apiary examples ──────────────────────────────────────────────────
  if (args[0] === "examples") {
    printExamples();
    return;
  }

  // ── --help anywhere ────────────────────────────────────────────────────
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  // ── --version / -v ──────────────────────────────────────────────────
  if (args.includes("--version") || args.includes("-v") || args[0] === "version") {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const pkg = require("../../package.json");
      console.log(pkg.version);
    } catch {
      console.log("unknown");
    }
    return;
  }

  // ── apiary update — redirect to npm ──────────────────────────────────
  if (args[0] === "update") {
    console.log("To update apiary, run:  npm update -g @gorlitzer/apiary");
    return;
  }

  // ── Version check (non-blocking) ──────────────────────────────────────
  printUpdateNotice();
  checkForUpdate();

  // ── apiary stop [<name> | --all] ──────────────────────────────────────
  if (args[0] === "stop") {
    const rest = args.slice(1);
    const all = rest.includes("--all");
    // Positional name or --name flag
    const positional = rest.find((a) => !a.startsWith("--"));
    const name = getFlag("name", rest) ?? positional;
    await stopClaude(name, all);
    return;
  }

  // ── apiary ps ────────────────────────────────────────────────────────────
  if (args[0] === "ps") {
    const rooms = listRoomSessions();
    const agents = listClaudeSessions();
    if (rooms.length === 0 && agents.length === 0) {
      console.log("No active sessions.");
      return;
    }

    for (const r of rooms) {
      let alive = false;
      try { process.kill(r.pid, 0); alive = true; } catch { /* dead */ }
      if (!alive) continue;
      const joinUrl = buildShareUrl(
        r.publicUrl !== r.serverUrl ? r.publicUrl : r.serverUrl,
        r.memberToken,
      );
      console.log(`  \x1b[1m${r.roomName}\x1b[0m  \x1b[2m(room, pid ${r.pid})\x1b[0m`);
      console.log(`    \x1b[2mJoin:\x1b[0m  \x1b[36mapiary join\x1b[0m ${joinUrl}`);
    }

    for (const s of agents) {
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch { /* dead */ }
      const status = alive ? "running" : "stale";
      console.log(`  ${s.agentName}  (pid ${s.pid}, ${status})`);
    }
    return;
  }

  // ── apiary room [create | resume | list | <name>] ───────────────────────
  if (args[0] === "room") {
    const sub = args[1];
    const roomArgs = args.slice(2);

    // apiary room create
    if (sub === "create") {
      const portStr = getFlag("port", roomArgs);
      const port = portStr ? parseInt(portStr, 10) : undefined;
      const { roomCreate } = await import("./room.js");
      await roomCreate({
        room: getFlag("room", roomArgs) ?? roomArgs.find((a) => !a.startsWith("--")),
        port,
        share: roomArgs.includes("--share"),
        expose: roomArgs.includes("--expose"),
      });
      return;
    }

    // apiary room resume <name>
    if (sub === "resume") {
      const name = roomArgs.find((a) => !a.startsWith("--"));
      if (!name) {
        console.error("Usage: apiary room resume <name>");
        process.exit(1);
      }
      const { roomResume } = await import("./room.js");
      await roomResume(name);
      return;
    }

    // apiary room list
    if (sub === "list" || sub === "ls") {
      const { roomList } = await import("./room.js");
      roomList();
      return;
    }

    // apiary room stop <name>
    if (sub === "stop") {
      const name = roomArgs.find((a) => !a.startsWith("--"));
      if (!name) {
        console.error("Usage: apiary room stop <name>");
        process.exit(1);
      }
      const { roomStop } = await import("./room.js");
      await roomStop(name);
      return;
    }

    // apiary room <name> [<displayName>] — daemon-backed host+join (legacy compat)
    {
      const allRoomArgs = args.slice(1);
      const positionals = allRoomArgs.filter((a) => !a.startsWith("--"));
      const roomName = positionals[0];
      const userName = positionals[1] ?? getFlag("name", allRoomArgs);
      const portStr = getFlag("port", allRoomArgs);
      const port = portStr ? parseInt(portStr, 10) : undefined;
      if (port !== undefined && (isNaN(port) || port < 0 || port > 65535)) {
        console.error(`Invalid port: ${portStr}`);
        process.exit(1);
      }

      // Daemon-backed so Ctrl+C only kills TUI
      const { spawnDaemonServer } = await import("./room.js");
      const daemon = await spawnDaemonServer({
        room: roomName,
        port,
        share: allRoomArgs.includes("--share"),
        expose: allRoomArgs.includes("--expose"),
      });
      if (!daemon) {
        console.error("Failed to start server.");
        process.exit(1);
      }
      const adminJoinUrl = buildShareUrl(daemon.serverUrl, daemon.adminToken);
      const participantShareUrl = buildShareUrl(
        daemon.publicUrl !== daemon.serverUrl ? daemon.publicUrl : daemon.serverUrl,
        daemon.memberToken,
      );
      await join({ server: adminJoinUrl, name: userName, shareUrl: participantShareUrl });
      console.log(`\n  Server still running (room: ${daemon.roomName})`);
      console.log(`  Rejoin: apiary room resume ${daemon.roomName}\n`);
      return;
    }
  }

  // ── apiary mcp [<name>] [--admin] [--join <url>] ──────────────────────────
  if (args[0] === "mcp") {
    const restArgs = args.slice(1);
    const joinUrls = getAllFlags("join", restArgs);
    const positionalName = restArgs.find((a, i) => {
      if (a.startsWith("--")) return false;
      if (i > 0 && new Set(["--name", "--join"]).has(restArgs[i - 1])) return false;
      return true;
    });
    const name = getFlag("name", restArgs) ?? positionalName;

    // Check for a pending invite dropped by `apiary room resume`
    const pendingUrls = [...joinUrls];
    if (name) {
      const { readAndConsumeInvite } = await import("./room.js");
      const inviteUrl = readAndConsumeInvite(name);
      if (inviteUrl) pendingUrls.push(inviteUrl);
    }

    const { runMcpServer } = await import("./mcp/run.js");
    await runMcpServer({
      joinUrls: pendingUrls.length > 0 ? pendingUrls : undefined,
      name,
      admin: restArgs.includes("--admin"),
    });
    return;
  }

  // ── apiary run <runtime> / apiary claude / apiary codex / apiary opencode
  const isRunAlias = args[0] === "claude" || args[0] === "codex" || args[0] === "opencode";
  if ((args[0] === "run" && (args[1] === "claude" || args[1] === "opencode" || args[1] === "codex")) || isRunAlias) {
    const runtime = isRunAlias ? args[0] : args[1];
    const restArgs = args.slice(isRunAlias ? 1 : 2);

    // Split on -- separator: apiary flags before, passthrough args after
    const ddIndex = restArgs.indexOf("--");
    const apiaryArgs = ddIndex >= 0 ? restArgs.slice(0, ddIndex) : restArgs;
    const explicitExtra = ddIndex >= 0 ? restArgs.slice(ddIndex + 1) : [];

    // Known apiary flags — anything else gets forwarded to the underlying tool
    const KNOWN_FLAGS = new Set(["--name", "--admin", "--headless", "--resume", "--join", "--background"]);
    const unknownArgs: string[] = [];
    for (let i = 0; i < apiaryArgs.length; i++) {
      const arg = apiaryArgs[i];
      if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg)) {
        unknownArgs.push(arg);
        // If the next arg isn't a flag, it's probably a value — forward it too
        if (i + 1 < apiaryArgs.length && !apiaryArgs[i + 1].startsWith("--")) {
          unknownArgs.push(apiaryArgs[++i]);
        }
      }
    }
    const extraArgs = [...unknownArgs, ...explicitExtra];

    const joinUrls = getAllFlags("join", apiaryArgs);

    // First positional arg (not a flag, not consumed by a known flag) is the name
    const positionalName = apiaryArgs.find((a, i) => {
      if (a.startsWith("--")) return false;
      // Check if previous arg is a flag that takes a value
      if (i > 0 && KNOWN_FLAGS.has(apiaryArgs[i - 1])) return false;
      return true;
    });

    const runtimeOptions = {
      joinUrls: joinUrls.length > 0 ? joinUrls : undefined,
      name: getFlag("name", apiaryArgs) ?? positionalName,
      admin: apiaryArgs.includes("--admin"),
      headless: apiaryArgs.includes("--headless"),
      resume: apiaryArgs.includes("--resume"),
      background: apiaryArgs.includes("--background"),
      extraArgs,
    };

    if (runtime === "claude") {
      await runClaude(runtimeOptions);
    } else if (runtime === "opencode") {
      await runOpencode(runtimeOptions);
    } else {
      await runCodex(runtimeOptions);
    }
    return;
  }

  // ── apiary join <url> [<name>] ──────────────────────────────────────────
  if (args[0] === "join") {
    const server = args[1];
    if (!server || server.startsWith("--")) {
      console.error("Usage: apiary join <url> [<name>] [--guest] [--headless]");
      process.exit(1);
    }
    // Second positional arg is the name
    const joinName = args[2] && !args[2].startsWith("--") ? args[2] : getFlag("name");
    await join({
      server,
      name: joinName,
      guest: args.includes("--guest"),
      headless: args.includes("--headless"),
    });
    return;
  }

  // ── apiary serve ───────────────────────────────────────────────────────
  if (args[0] === "serve") {
    const portStr = getFlag("port");
    const port = portStr ? parseInt(portStr, 10) : undefined;
    if (port !== undefined && (isNaN(port) || port < 0 || port > 65535)) {
      console.error(`Invalid port: ${portStr}`);
      process.exit(1);
    }
    const shareTtlStr = getFlag("share-token-ttl");
    const shareTtlMs = shareTtlStr ? parseInt(shareTtlStr, 10) : undefined;
    await serve({
      room: getFlag("room"),
      port,
      share: args.includes("--share"),
      headless: args.includes("--headless"),
      expose: args.includes("--expose"),
      corsOrigins: getAllFlags("cors-origin"),
      shareTtlMs,
    });
    return;
  }

  // ── apiary (bare) — host + join ────────────────────────────────────────
  if (args.length === 0 || args[0]?.startsWith("--")) {
    const portStr = getFlag("port");
    const port = portStr ? parseInt(portStr, 10) : undefined;
    if (port !== undefined && (isNaN(port) || port < 0 || port > 65535)) {
      console.error(`Invalid port: ${portStr}`);
      process.exit(1);
    }
    const result = await serve({
      room: getFlag("room"),
      port,
      share: args.includes("--share"),
      quiet: true,
      expose: args.includes("--expose"),
      corsOrigins: getAllFlags("cors-origin"),
    });

    // Host joins locally as admin using the admin share token
    const adminJoinUrl = buildShareUrl(result.serverUrl, result.adminToken);
    const participantShareUrl = buildShareUrl(
      result.publicUrl !== result.serverUrl ? result.publicUrl : result.serverUrl,
      result.memberToken,
    );

    await join({
      server: adminJoinUrl,
      name: getFlag("name"),
      shareUrl: participantShareUrl,
    });
    return;
  }

  // ── Unknown command ────────────────────────────────────────────────────
  console.error(`Unknown command: ${args[0]}\n`);
  printUsage(console.error);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
