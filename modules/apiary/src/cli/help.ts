/**
 * `apiary --help` and `apiary examples`.
 *
 * Split out of index.ts so it can be imported and asserted directly. The
 * drift test used to spawn the built binary, which made it depend on `dist/`
 * being current — and `make release` runs the tests BEFORE the build, so any
 * help change broke the release until dist was rebuilt by hand. index.ts
 * cannot be imported instead: it calls main() at module top level, so
 * importing it runs the CLI.
 */

import { getVersion } from "./version.js";

export function printUsage(stream: typeof console.log = console.log): void {
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
  stream(`  ${G}${B}Who can reach the room${R}`);
  stream(row(`${D}--bind ${Y}tailscale${R}`, "Your devices anywhere, via Tailscale — not the local network"));
  stream(row(`${D}--bind ${Y}lan${R}`, "Anyone on the same wifi"));
  stream(row(`${D}--share${R}`, "A public cloudflared URL, for people off your tailnet"));
  stream(`      ${D}room create asks this if you don't pass it. Default: this machine only.${R}`);
  stream("");
  stream(`  ${G}${B}Participants${R}  ${D}(each person connects their own agents)${R}`);
  stream(row(`${C}apiary join ${Y}<url>${R} ${D}[${Y}<name>${R}${D}]${R}`, "Join a workspace"));
  stream(row(`${C}apiary claude ${Y}<name>${R} ${D}[--admin]${R}`, "Connect Claude Code to the room"));
  stream(row(`${C}apiary codex ${Y}<name>${R} ${D}[--admin]${R}`, "Connect Codex to the room"));
  stream(row(`${D}--mode ${Y}standby${R}`, "Quiet until @mentioned, pinged or whispered to"));
  stream(`      ${D}In room create, suffix the alias instead: ${R}${C}bee:standby${R}${D}. The first agent${R}`);
  stream(`      ${D}listens to everything, the rest go standby — one remark, one reply.${R}`);
  stream("");
  stream(`  ${G}${B}In the room${R}`);
  stream(row(`${C}/watch ${Y}<agent>${R}`, "Open that agent's terminal in a new window (Ctrl+<n> too)"));
  stream(row(`${C}/setmode ${Y}<agent> <mode>${R}`, "Change who an agent listens to, live"));
  stream(row(`${C}/ping ${Y}<agent>${R}`, "Ask for a one-line status"));
  stream(`      ${D}The strip shows each agent as ✓ idle, … working, or ⏸ needs you —${R}`);
  stream(`      ${D}"needs you" means it is stuck on something only you can clear.${R}`);
  stream("");
  stream(row(`${C}apiary ps${R}`, "List active rooms + agents"));
  stream(row(`${C}apiary stop ${D}[${Y}<name>${R}${D} | --all]${R}`, "Stop agents + rooms"));
  stream(row(`${C}apiary examples${R}`, "Examples + workflows"));
  stream("");
}

export function printExamples(): void {
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
  log(`    ${C}apiary room ${Y}sprint-42${R} ${D}--bind tailscale${R}     ${D}# reachable from your phone, over Tailscale only${R}`);
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
  log(`    ${C}apiary codex ${Y}Rex${R} ${D}--mode standby${R}         ${D}# quiet until @mentioned, pinged or whispered${R}`);
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
  log(`    ${C}/watch ${Y}<name>${R}     ${D}open that agent's terminal in a new window (or Ctrl+<n>)${R}`);
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
