#!/usr/bin/env node

/** apiary CLI — shared rooms for AI agents. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, listRoomSessions } from "./serve.js";
import { join } from "./join.js";
import { runClaude, stopClaude, listClaudeSessions } from "./claude/run.js";
import { runOpencode, stopOpencode, listOpencodeSessions } from "./opencode/run.js";
import { runCodex, stopCodex, listCodexSessions } from "./codex/run.js";
import { buildShareUrl } from "./auth.js";
import { parseEngagementMode } from "../agent/engagement.js";
import { resolveBindAddress } from "./bind.js";
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
  return readPackageField("version") ?? process.env.npm_package_version ?? "unknown";
}

/** Read a top-level field from this package's package.json. Null on failure. */
function readPackageField(field: string): string | null {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, "../../package.json"), "utf-8"));
    return typeof pkg[field] === "string" ? pkg[field] : null;
  } catch {
    return null;
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

  const COL = 40;
  const ansi = /\x1b\[[0-9;]*m/g;
  const row = (cmd: string, desc: string) => {
    const visible = cmd.replace(ansi, "").length;
    return `  ${cmd}${" ".repeat(Math.max(2, COL - visible))}${D}${desc}${R}`;
  };

  stream("");
  stream(`  ${Y}${B}apiary${R} ${D}v${getVersion()} — shared rooms for AI agents${R}`);
  stream("");
  stream(`  ${G}${B}Workspace${R}`);
  stream(row(`${C}apiary room create${R}`, "Create a workspace + invite participants"));
  stream(row(`${C}apiary room ${Y}<name>${R} ${D}[--share]${R}`, "Start a workspace + join"));
  stream(row(`${C}apiary room resume ${Y}<name>${R}`, "Rejoin your workspace"));
  stream(row(`${C}apiary room list${R}`, "List your workspaces"));
  stream("");
  stream(`  ${G}${B}Participants${R}  ${D}(each person connects their own agents)${R}`);
  stream(row(`${C}apiary join ${Y}<url>${R} ${D}[${Y}<name>${R}${D}]${R}`, "Join a workspace"));
  stream(row(`${C}apiary claude ${Y}<name>${R} ${D}[--admin]${R}`, "Connect Claude Code to the room"));
  stream(row(`${C}apiary codex ${Y}<name>${R} ${D}[--admin]${R}`, "Connect Codex to the room"));
  stream("");
  stream(row(`${C}apiary ps${R}`, "List active rooms + agents"));
  stream(row(`${C}apiary stop ${D}[${Y}<name>${R}${D} | --all]${R}`, "Stop agents + rooms"));
  stream(row(`${C}apiary examples${R}`, "Examples + workflows"));
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

  const log = console.log.bind(console);

  log("");
  log(`  ${Y}${B}apiary examples${R}`);
  log("");

  // ── Create a workspace
  log(`  ${G}${B}Create a workspace${R}`);
  log(`    ${C}apiary room create${R}                        ${D}# guided setup — name it, invite participants${R}`);
  log(`    ${C}apiary room ${Y}sprint-42${R}                    ${D}# quick start — host + join immediately${R}`);
  log(`    ${C}apiary room ${Y}sprint-42${R} ${D}--share${R}              ${D}# same, with a public tunnel URL${R}`);
  log(`    ${D}Ctrl+C leaves the server running — rejoin anytime:${R}`);
  log(`    ${C}apiary room resume ${Y}sprint-42${R}`);
  log("");

  // ── Join a workspace
  log(`  ${G}${B}Join a workspace${R}  ${D}(each person connects their own agents)${R}`);
  log(`    ${C}apiary join ${Y}<url>${R}                        ${D}# join as a participant${R}`);
  log(`    ${C}apiary join ${Y}<url>${R} ${D}--guest${R}               ${D}# join read-only${R}`);
  log(`    ${C}apiary claude ${Y}Cleo${R} ${D}--admin${R}               ${D}# connect your Claude Code agent${R}`);
  log(`    ${C}apiary codex ${Y}Rex${R}                        ${D}# connect your Codex agent${R}`);
  log(`    ${D}Tell your agent the room URL — it joins via apiary__join_room.${R}`);
  log("");

  // ── Authority / roles
  log(`  ${G}${B}Authority${R}  ${D}admin > product_owner > member > guest${R}`);
  log(`    ${C}/promote ${Y}<name>${R}   ${D}# elevate to product owner (can manage members + modes)${R}`);
  log(`    ${C}/demote ${Y}<name>${R}    ${D}# drop product owner back to member${R}`);
  log(`    ${C}/mute ${Y}<name>${R}      ${D}# demote to guest (read-only)${R}`);
  log(`    ${C}/unmute ${Y}<name>${R}    ${D}# restore to member${R}`);
  log(`    ${C}/kick ${Y}<name>${R}      ${D}# remove from the room (admin only)${R}`);
  log(`    ${C}/share ${D}--as member${R} ${D}# generate a share link at a specific tier${R}`);
  log("");

  // ── TUI commands
  log(`  ${G}${B}TUI commands${R}`);
  log(`    ${C}/who${R}              ${D}list participants with their roles${R}`);
  log(`    ${C}/ping ${Y}<name>${R}      ${D}ping for a status check${R}`);
  log(`    ${C}/setmode ${Y}<n> <m>${R}  ${D}set engagement mode (admin / product owner)${R}`);
  log(`    ${C}/share${R}            ${D}generate share links${R}`);
  log(`    ${C}/tunnel${R}           ${D}start a cloudflared tunnel mid-session (admin)${R}`);
  log(`    ${C}/clear${R}            ${D}wipe room history (admin)${R}`);
  log(`    ${C}/sound${R}            ${D}toggle notification sounds${R}`);
  log(`    ${C}/leave${R}            ${D}disconnect${R}`);
  log("");

  // ── Messaging
  log(`  ${G}${B}Messaging${R}  ${D}(agent tool params)${R}`);
  log(`    ${D}Whisper — visible only to named recipients:${R}`);
  log(`    ${C}apiary__send_message(room, content, null, ${Y}["Alice", "Bob"]${R}${C})${R}`);
  log(`    ${D}Attachments — local file or image:${R}`);
  log(`    ${C}apiary__send_message(room, content, null, null, ${Y}[{ type: "path", path: "..." }]${R}${C})${R}`);
  log("");

  // ── Sessions
  log(`  ${G}${B}Sessions${R}`);
  log(`    ${C}apiary ps${R}                            ${D}# list rooms + agents with join links${R}`);
  log(`    ${C}apiary stop ${Y}Cleo${R}                     ${D}# stop one agent${R}`);
  log(`    ${C}apiary stop ${D}--all${R}                     ${D}# stop everything${R}`);
  log("");
}

/**
 * Resolve `--bind` for a command, exiting with an explanation if it cannot be
 * satisfied. Returns undefined when the flag was not passed.
 */
function bindFlag(args: string[]): string | undefined {
  const spec = getFlag("bind", args);
  if (!spec) return undefined;
  const res = resolveBindAddress(spec);
  if (!res.ok) {
    console.error(`Error: ${res.error}`);
    process.exit(1);
  }
  if (res.note) console.log(`  Listening on ${res.address} — ${res.note}`);
  return res.address;
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

  // ── apiary update — git pull + build (or npm fallback) ──────────────
  if (args[0] === "update") {
    const { runUpdate } = await import("./update.js");
    const targetVersion = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    await runUpdate(targetVersion);
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

    const { roomStop } = await import("./room.js");
    if (all) {
      // Stop all rooms first (each roomStop also kills its agent tmux sessions).
      // Pass the pre-loaded session to avoid O(N²) disk scans.
      for (const r of listRoomSessions()) {
        try { await roomStop(r.roomName, { session: r, quietIfDead: true }); } catch { /* keep going */ }
      }
      // Then stop any remaining standalone agent runtimes (claude, codex, opencode).
      await stopClaude(undefined, true);
      await stopCodex(undefined, true);
      await stopOpencode(undefined, true);
      return;
    }
    if (name) {
      // If the name matches a room, stop the room (agents + server). Otherwise treat as agent name.
      const room = listRoomSessions().find((s) => s.roomName === name);
      if (room) { await roomStop(name, { session: room }); return; }

      // Match against agent runtimes by name.
      if (listCodexSessions().some((s) => s.agentName === name)) {
        await stopCodex(name, false); return;
      }
      if (listOpencodeSessions().some((s) => s.agentName === name)) {
        await stopOpencode(name, false); return;
      }
    }
    await stopClaude(name, false);
    return;
  }

  // ── apiary ps ────────────────────────────────────────────────────────────
  if (args[0] === "ps") {
    const rooms = listRoomSessions();
    const claudeAgents = listClaudeSessions().map((s) => ({ runtime: "claude", agentName: s.agentName, pid: s.pid }));
    const codexAgents = listCodexSessions().map((s) => ({ runtime: "codex", agentName: s.agentName, pid: s.pid }));
    const opencodeAgents = listOpencodeSessions().map((s) => ({ runtime: "opencode", agentName: s.agentName, pid: s.pid }));
    const agents = [...claudeAgents, ...codexAgents, ...opencodeAgents];

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
      console.log(`  ${s.agentName}  (${s.runtime}, pid ${s.pid}, ${status})`);
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
        bind: bindFlag(roomArgs),
        foundation: !roomArgs.includes("--no-foundation"),
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
      const { spawnDaemonServer, isDaemonResult } = await import("./room.js");
      const daemonRes = await spawnDaemonServer({
        room: roomName,
        port,
        share: allRoomArgs.includes("--share"),
        expose: allRoomArgs.includes("--expose"),
        bind: bindFlag(allRoomArgs),
      });
      if (!isDaemonResult(daemonRes)) {
        console.error(`Failed to start server: ${daemonRes.reason}`);
        if (daemonRes.portInUse) {
          console.error(`Tip: a previous room daemon is bound. Run 'apiary ps' to inspect, 'apiary stop --all' to free it.`);
        } else if (daemonRes.stderr?.trim()) {
          console.error(daemonRes.stderr);
        }
        process.exit(1);
      }
      const daemon = daemonRes;
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
      const { consumeInvite } = await import("./invites.js");
      const inviteUrl = consumeInvite(name);
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
    // --mode must be listed here or it would be forwarded to the underlying
    // CLI as an unknown flag, where claude/codex reject it.
    const KNOWN_FLAGS = new Set(["--name", "--admin", "--headless", "--resume", "--join", "--background", "--mode"]);
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
      mode: parseEngagementMode(getFlag("mode", apiaryArgs)),
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
      bind: bindFlag(args),
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
      bind: bindFlag(args),
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
