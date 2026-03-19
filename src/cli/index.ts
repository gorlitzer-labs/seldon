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
  stream(`  ${C}apiary --room ${Y}<name>${R} ${D}[--share] [--name <name>]${R}       Host a room + join the TUI`);
  stream(`  ${C}apiary join ${Y}<url>${R} ${D}[--name <name>] [--guest]${R}          Join an existing room`);
  stream(`  ${C}apiary run claude${R} ${D}[--name <n>] [--admin] [-- …]${R}       Launch Claude Code`);
  stream(`  ${C}apiary run codex${R} ${D}[--name <n>] [--admin] [-- …]${R}        Launch Codex`);
  stream(`  ${C}apiary ps${R}                                              List active sessions`);
  stream(`  ${C}apiary stop${R} ${D}[--name <n> | --all]${R}                       Stop agents`);
  stream(`  ${C}apiary update${R}                                          Pull latest + rebuild`);
  stream("");
  stream(`  ${G}${B}Quick start${R}`);
  stream(`    ${D}Terminal 1:${R}  ${C}apiary --room ${Y}sweatshop${R} ${D}--name ${Y}BeeKeeper${R}`);
  stream(`    ${D}Terminal 2:${R}  ${C}apiary run claude${R} ${D}--name ${Y}Unpaid-Intern${R} ${D}--admin${R}`);
  stream(`    ${D}Terminal 3:${R}  ${C}apiary run claude${R} ${D}--name ${Y}Expendable3${R}`);
  stream(`    ${D}Tell them the URL. They join.${R}`);
  stream(`    ${D}--admin → can kick, mute, and manage other participants.${R}`);
  stream(`    ${D}Detach with Ctrl+B D, resume with: ${C}apiary run claude --resume${R}`);
  stream("");
}

async function main(): Promise<void> {
  // ── --help anywhere ────────────────────────────────────────────────────
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  // ── apiary update ─────────────────────────────────────────────────────
  if (args[0] === "update") {
    await runUpdate();
    return;
  }

  // ── Version check (non-blocking) ──────────────────────────────────────
  printUpdateNotice();
  checkForUpdate();

  // ── apiary stop ───────────────────────────────────────────────────────
  if (args[0] === "stop") {
    const rest = args.slice(1);
    // Support both "apiary stop claude --name X" and "apiary stop --name X"
    const hasRuntime = rest[0] && !rest[0].startsWith("--");
    const flagArgs = hasRuntime ? rest.slice(1) : rest;
    const name = getFlag("name", flagArgs);
    const all = flagArgs.includes("--all");
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

  // ── apiary run <runtime> ───────────────────────────────────────────────
  if (args[0] === "run" && (args[1] === "claude" || args[1] === "opencode" || args[1] === "codex")) {
    const runtime = args[1];
    const restArgs = args.slice(2);

    // Split on -- separator: apiary flags before, passthrough args after
    const ddIndex = restArgs.indexOf("--");
    const apiaryArgs = ddIndex >= 0 ? restArgs.slice(0, ddIndex) : restArgs;
    const extraArgs = ddIndex >= 0 ? restArgs.slice(ddIndex + 1) : [];

    const joinUrls = getAllFlags("join", apiaryArgs);

    const runtimeOptions = {
      joinUrls: joinUrls.length > 0 ? joinUrls : undefined,
      name: getFlag("name", apiaryArgs),
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

  // ── apiary join <url> ──────────────────────────────────────────────────
  if (args[0] === "join") {
    const server = args[1];
    if (!server || server.startsWith("--")) {
      console.error("Usage: apiary join <url> [--name <name>] [--guest] [--headless]");
      process.exit(1);
    }
    await join({
      server,
      name: getFlag("name"),
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
