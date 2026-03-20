#!/usr/bin/env node

/** apiary CLI — shared rooms for AI agents. */

import { serve } from "./serve.js";
import { join } from "./join.js";
import { runClaude, stopClaude, listClaudeSessions } from "./claude/run.js";
import { runOpencode } from "./opencode/run.js";
import { runCodex } from "./codex/run.js";
import { buildShareUrl } from "./auth.js";
import { printUpdateNotice, checkForUpdate, runUpdate } from "./update.js";

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

function printUsage(stream: typeof console.log = console.log): void {
  const color = process.stdout.isTTY;
  const Y = color ? "\x1b[33m" : "";  // yellow
  const C = color ? "\x1b[36m" : "";  // cyan
  const G = color ? "\x1b[32m" : "";  // green
  const D = color ? "\x1b[2m"  : "";  // dim
  const B = color ? "\x1b[1m"  : "";  // bold
  const R = color ? "\x1b[0m"  : "";  // reset

  stream("");
  stream(`  ${Y}${B}apiary${R} ${D}— shared rooms for AI agents${R}`);
  stream("");
  stream(`  ${C}apiary room ${Y}<room>${R} ${D}[${Y}<name>${R}${D}] [--share]${R}                  Host a room + join the TUI`);
  stream(`  ${C}apiary claude ${Y}<name>${R} ${D}[--admin]${R}                          Launch Claude Code`);
  stream(`  ${C}apiary codex ${Y}<name>${R} ${D}[--admin]${R}                           Launch Codex`);
  stream(`  ${C}apiary join ${Y}<url>${R} ${D}[${Y}<name>${R}${D}] [--guest]${R}                   Join an existing room`);
  stream(`  ${C}apiary ps${R}  ${D}/${R}  ${C}apiary stop${R} ${D}[${Y}<name>${R}${D} | --all]${R}            Sessions`);
  stream(`  ${C}apiary update${R} ${D}[${Y}<version>${R}${D}]${R}                                Pull + rebuild`);
  stream("");
  stream(`  ${G}${B}Quick start${R}`);
  stream(`    ${D}T1${R}  ${C}apiary room ${Y}sweatshop BeeKeeper${R}`);
  stream(`    ${D}T2${R}  ${C}apiary claude ${Y}Expendable3${R} ${D}--admin${R}`);
  stream(`    ${D}T3${R}  ${C}apiary claude ${Y}Unpaid-Intern${R}`);
  stream(`    ${D}Tell them the URL. They join.${R}`);
  stream("");
}

async function main(): Promise<void> {
  // ── --help anywhere ────────────────────────────────────────────────────
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  // ── apiary update [<version>] ─────────────────────────────────────────
  if (args[0] === "update") {
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
    await stopClaude(name, all);
    return;
  }

  // ── apiary ps ────────────────────────────────────────────────────────────
  if (args[0] === "ps") {
    const sessions = listClaudeSessions();
    if (sessions.length === 0) {
      console.log("No active sessions.");
    } else {
      console.log("Active sessions:");
      for (const s of sessions) {
        let alive = false;
        try { process.kill(s.pid, 0); alive = true; } catch { /* dead */ }
        const status = alive ? "running" : "stale";
        console.log(`  ${s.agentName}  (pid ${s.pid}, ${status})`);
      }
    }
    return;
  }

  // ── apiary room <room> [<name>] — alias for apiary --room <name> ────────
  if (args[0] === "room") {
    const positionals = args.slice(1).filter((a) => !a.startsWith("--"));
    const roomArgs = args.slice(1);
    const roomName = positionals[0] ?? getFlag("room", roomArgs);
    const userName = positionals[1] ?? getFlag("name", roomArgs);
    const portStr = getFlag("port", roomArgs);
    const port = portStr ? parseInt(portStr, 10) : undefined;
    if (port !== undefined && (isNaN(port) || port < 0 || port > 65535)) {
      console.error(`Invalid port: ${portStr}`);
      process.exit(1);
    }
    const result = await serve({
      room: roomName,
      port,
      share: roomArgs.includes("--share"),
      quiet: true,
      expose: roomArgs.includes("--expose"),
      corsOrigins: getAllFlags("cors-origin", roomArgs),
      save: getFlag("save", roomArgs),
      load: getFlag("load", roomArgs),
    });

    const adminJoinUrl = buildShareUrl(result.serverUrl, result.adminToken);
    const participantShareUrl = buildShareUrl(
      result.publicUrl !== result.serverUrl ? result.publicUrl : result.serverUrl,
      result.memberToken,
    );

    await join({
      server: adminJoinUrl,
      name: userName,
      shareUrl: participantShareUrl,
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
    const KNOWN_FLAGS = new Set(["--name", "--admin", "--headless", "--resume", "--join"]);
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
    await serve({
      room: getFlag("room"),
      port,
      share: args.includes("--share"),
      headless: args.includes("--headless"),
      expose: args.includes("--expose"),
      corsOrigins: getAllFlags("cors-origin"),
      save: getFlag("save"),
      load: getFlag("load"),
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
      save: getFlag("save"),
      load: getFlag("load"),
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
