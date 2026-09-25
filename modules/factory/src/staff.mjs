// `factory staff <project>` — put an agent in a project's hive, for real.
//
// `apiary claude <name> --admin` on its own starts an agent in tmux that sits OUTSIDE every
// room: it only auto-joins when ~/.apiary/invites/<name> holds the room's join URL. That is
// what the supervisor's respawn does, and what every "put an agent on it" hint skipped —
// so the documented next step started an agent that never joined its hive.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { c, say, ok, warn } from "./lib/log.mjs";
import { readRegistry } from "./lib/hive.mjs";

const HARNESSES = new Set(["claude", "codex"]);
// apiary joins these into a shell command in the agent's tmux pane, so they are checked
// against a strict shape here: a model id or an effort level, never shell syntax.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,79}$/;
const EFFORT_RE = /^(minimal|low|medium|high|xhigh|max)$/;

// The per-harness spelling of "run on this model at this effort".
//   claude: claude --model M --effort E      (apiary forwards unknown --flags as-is)
//   codex:  codex --model M -c model_reasoning_effort=E   (-c is a short flag, so it has to
//           ride after apiary's `--` separator or apiary would drop it)
export function modelArgs(harness, { model, effort } = {}) {
  if (model !== undefined && (typeof model !== "string" || !MODEL_RE.test(model))) throw new Error(`--model: not a model id: ${JSON.stringify(model)}`);
  if (effort !== undefined && (typeof effort !== "string" || !EFFORT_RE.test(effort))) throw new Error(`--effort must be one of minimal|low|medium|high|xhigh|max (got ${JSON.stringify(effort)})`);
  const args = [];
  if (model) args.push("--model", model);
  if (harness === "claude" && effort) args.push("--effort", effort);
  if (harness === "codex" && effort) args.push("--", "-c", `model_reasoning_effort=${effort}`);
  return args;
}
const invitePath = (name) => join(homedir(), ".apiary", "invites", name);

// apiary keys agents by name, machine-wide (tmux session apiary_<name>).
export function agentRunning(name) {
  try { execFileSync("tmux", ["has-session", "-t", `apiary_${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

// Running apiary agents whose pane is in `dir` — this project's agents, whatever their name.
// Names are machine-wide, so "is Coordinator running?" says nothing about WHICH project it
// serves: checking only the name started a second coordinator on a project that had one.
export function agentsInProject(dir) {
  let sessions = [];
  try { sessions = execFileSync("tmux", ["ls", "-F", "#{session_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((s) => s.startsWith("apiary_")); } catch { return []; }
  const want = realpathOr(dir);
  return sessions.filter((s) => {
    try {
      const cwd = execFileSync("tmux", ["display", "-p", "-t", s, "#{pane_current_path}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return realpathOr(cwd) === want;
    } catch { return false; }
  }).map((s) => s.slice("apiary_".length));
}
const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };

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
  const here = agentsInProject(h.dir);
  if (here.length && !flags.name && !flags.another) {
    ok(`${c.bold(h.name)} already has ${here.map((n) => c.bold(n)).join(", ")} working ${c.dim(`(tmux attach -t apiary_${here[0]}; --another to add one more)`)}`);
    return { name: here[0], already: true };
  }
  const extra = modelArgs(harness, { model: flags.model, effort: flags.effort });
  const name = pickAgentName(h.name, flags.name);
  if (agentRunning(name)) {
    ok(`${c.bold(name)} is already running ${c.dim(`(tmux attach -t apiary_${name})`)}`);
    return { name, already: true };
  }

  mkdirSync(join(homedir(), ".apiary", "invites"), { recursive: true });
  writeFileSync(invitePath(name), `${h.hive.serverUrl}/?token=${h.hive.adminToken}`);
  spawn("apiary", [harness, name, "--admin", "--background", ...extra], { cwd: h.dir, detached: true, stdio: "ignore" }).unref();
  const how = [harness, flags.model, flags.effort && `${flags.effort} effort`].filter(Boolean).join(" · ");
  ok(`started ${c.bold(name)} ${c.dim(`(${how})`)} in ${c.dim(h.dir)}`);

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
