// `factory staff <project>` — put an agent in a project's hive, for real.
//
// `apiary claude <name> --admin` on its own starts an agent in tmux that sits OUTSIDE every
// room: it only auto-joins when ~/.apiary/invites/<name> holds the room's join URL. That is
// what the supervisor's respawn does, and what every "put an agent on it" hint skipped —
// so the documented next step started an agent that never joined its hive.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { c, say, ok, warn } from "./lib/log.mjs";
import { readRegistry } from "./lib/hive.mjs";

const HARNESSES = new Set(["claude", "codex"]);
const invitePath = (name) => join(homedir(), ".apiary", "invites", name);

// apiary keys agents by name, machine-wide (tmux session apiary_<name>).
export function agentRunning(name) {
  try { execFileSync("tmux", ["has-session", "-t", `apiary_${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

// "Coordinator" if free, else "<project>-coordinator" — two projects must not share one agent.
export function pickAgentName(project, wanted, running = agentRunning) {
  if (wanted) return wanted;
  if (!running("Coordinator")) return "Coordinator";
  return `${project}-coordinator`;
}

export function findHive(target) {
  const asDir = resolve(target || process.cwd());
  const p = join(asDir, ".factory.json");
  if (existsSync(p)) { const { name, hive } = JSON.parse(readFileSync(p, "utf8")); return { name, dir: asDir, hive }; }
  const e = readRegistry().find((x) => x.name === target);
  return e ? { name: e.name, dir: e.dir, hive: e.hive } : null;
}

export async function factoryStaff(target, flags = {}) {
  const h = findHive(target);
  if (!h) throw new Error(`no hive for ${target || "this folder"} — run \`seldon adopt\` there first`);
  if (!h.hive?.serverUrl || !h.hive?.adminToken) throw new Error(`${h.name} has no hive recorded — re-run \`seldon adopt\``);
  const harness = flags.agent || "claude";
  if (!HARNESSES.has(harness)) throw new Error(`--agent must be claude or codex (got ${harness})`);
  const name = pickAgentName(h.name, flags.name);
  if (agentRunning(name)) {
    ok(`${c.bold(name)} is already running ${c.dim(`(tmux attach -t apiary_${name})`)}`);
    return { name, already: true };
  }

  mkdirSync(join(homedir(), ".apiary", "invites"), { recursive: true });
  writeFileSync(invitePath(name), `${h.hive.serverUrl}/?token=${h.hive.adminToken}`);
  spawn("apiary", [harness, name, "--admin", "--background"], { cwd: h.dir, detached: true, stdio: "ignore" }).unref();
  ok(`started ${c.bold(name)} ${c.dim(`(${harness})`)} in ${c.dim(h.dir)}`);

  // The runtime deletes the invite once the agent is really in the room.
  if (!flags["no-wait"]) {
    const deadline = Date.now() + (parseInt(flags.wait || "90", 10) * 1000);
    while (existsSync(invitePath(name)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(invitePath(name))) warn(`${name} has not joined ${h.name} yet — it keeps trying; watch: tmux attach -t apiary_${name}`);
    else ok(`${name} joined the ${c.bold(h.name)} hive`);
  }
  say(c.dim(`  watch it work: tmux attach -t apiary_${name}   ·   factory board`));
  return { name, dir: h.dir, joined: !existsSync(invitePath(name)) };
}
