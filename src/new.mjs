// `factory new "<idea>"` — the Front Door. Runs the deterministic front of the assembly line:
//   idea -> repo -> foundation init -> seed PRD + QUEUE -> open an apiary hive (daemon).
// The agent-driven half (plan + build) is handed to the hive: add a coordinator, it runs /prd +
// /plan-phase and dispatches. Supervised autonomy — deterministic setup, agents do the thinking.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { c, say, step, ok, warn, err } from "./lib/log.mjs";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-") || "project";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const has = (cmd) => { try { sh("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };

export async function factoryNew(idea, flags) {
  if (!idea) throw new Error('usage: factory new "<idea>" [--name <n>] [--dir <path>] [--here] [--port <p>]');
  const name = flags.name || slug(idea);
  const dir = flags.here ? process.cwd() : resolve(flags.dir || join(homedir(), "Desktop", name));
  const port = parseInt(flags.port || "7920", 10);

  say(`\n${c.honey("🏭 The Agentic Factory")} — new line: ${c.bold(name)}\n`);

  // 1. Repo
  step(1, "repo");
  if (!flags.here) {
    if (existsSync(dir)) throw new Error(`${dir} already exists — pick another --name/--dir or use --here`);
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    sh("git", ["init", "-q"], { cwd: dir });
    sh("git", ["-c", "user.email=factory@local", "-c", "user.name=factory", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  }
  ok(`repo at ${c.dim(dir)}`);

  // 2. Foundation
  step(2, "foundation");
  const fcmd = has("foundation") ? ["foundation", ["init", dir]] : ["npx", ["--yes", "github:gorlitzer/foundation", "init", dir]];
  sh(fcmd[0], fcmd[1], { stdio: "ignore" });
  ok(`Foundation installed ${c.dim(`(${fcmd[0]})`)}`);

  // 3. Seed the line: a PRD stub from the idea + a planning item in the QUEUE
  step(3, "seed");
  writeFileSync(join(dir, "docs", "PRD.md"),
    `# PRD — ${name}\n\n## Problem\n${idea}\n\n_Seed only. Run \`/prd\` to turn this into a full PRD, then \`/kickstart\` + \`/plan-phase\`._\n\n## Goals\n- _TBD (run /prd)_\n\n## Non-goals\n- _TBD_\n`);
  const fbin = fcmd[0] === "foundation" ? "foundation" : "npx";
  const fargs = (a) => fcmd[0] === "foundation" ? a : ["--yes", "github:gorlitzer/foundation", ...a];
  try { sh(fbin, fargs(["queue", `(P1) plan ${name}: run /prd then /plan-phase, then dispatch build tasks`, "--dir", dir]), { stdio: "ignore" }); } catch { /* seed queue best-effort */ }
  ok("PRD seed written + planning item queued");

  // 4. Open the hive (apiary daemon — survives this process)
  step(4, "hive");
  if (!has("apiary")) { warn("apiary not on PATH — skipping hive. Install/link apiary, then: apiary room " + name); return { name, dir, hive: null }; }
  const hive = await openHive(name, port);
  writeFileSync(join(dir, ".factory.json"), JSON.stringify({ name, hive }, null, 2));
  ok(`hive ${c.bold(name)} up on ${c.dim(hive.serverUrl)}`);

  // 5. Next steps
  say(`\n${c.honey("line is warm.")} next:`);
  say(`  ${c.dim("cd")} ${dir}`);
  say(`  ${c.cyan("apiary claude")} Coordinator --admin   ${c.dim("# it runs /prd + /plan-phase, then dispatches")}`);
  say(`  ${c.dim("join url:")} ${hive.joinUrl}`);
  say(`  ${c.dim("supervise (Phase 2):")} factory watch ${name}\n`);
  return { name, dir, hive };
}

// Spawn `apiary serve --room <name> --headless` detached; read the one JSON info line; unref.
function openHive(name, port) {
  return new Promise((res, rej) => {
    const child = spawn("apiary", ["serve", "--room", name, "--headless", "--port", String(port)], {
      detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rej(new Error("hive did not report startup in 15s")); } }, 15000);
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the pipe + detach so THIS process can exit while the daemon keeps running.
      child.stdout.removeAllListeners("data");
      child.stdout.destroy();
      child.unref();
      fn(v);
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        try {
          const info = JSON.parse(line.trim());
          finish(res, { ...info, joinUrl: `${info.serverUrl}/?token=${info.memberToken}` });
        } catch { /* keep buffering */ }
      }
    });
    child.on("error", (e) => finish(rej, e));
  });
}
