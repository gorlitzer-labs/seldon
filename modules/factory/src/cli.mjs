#!/usr/bin/env node
// factory — The AI Agentic Factory CLI. Dispatches every command:
// `new` (front door), `watch` (24/7 supervisor), `board`/`state` (control panel),
// `box` (sandboxed agent), `realms`, `decide`/`briefing` (escalation loop).
import { c, say, err } from "./lib/log.mjs";
import { factoryNew } from "./new.mjs";
import { factoryAdopt } from "./adopt.mjs";
import { factoryWatch } from "./watch.mjs";
import { factoryBoard, factoryLs } from "./board.mjs";
import { factoryDecide, factoryBriefing } from "./decide.mjs";
import { factoryBox } from "./box.mjs";
import { factoryRealms } from "./realms.mjs";
import { factoryState } from "./state.mjs";
import { VERSION, checkAndNotify } from "./update-check.mjs";

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
if (process.stdout.isTTY) checkAndNotify();

function parse(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Everything after a bare `--` is the user's command, not our flags.
    // Without this, `box . -- sh -c '...'` parses `--` as an empty flag and the
    // command is silently dropped.
    if (a === "--") { flags["--"] = args.slice(i + 1); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2), n = args[i + 1];
      if (n === undefined || n.startsWith("--")) flags[k] = true; else { flags[k] = n; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function help() {
  say([
    `${c.honey("🏭 factory")} — The AI Agentic Factory`,
    "",
    `${c.bold("Usage:")}  factory <command> [args]`,
    "",
    `  ${c.cyan("new")} "<idea>" [--name <n>] [--dir <p>] [--here] [--port <p>]`,
    `        Run the front of the line: repo -> Foundation -> seed -> apiary hive`,
    "",
    `  ${c.cyan("adopt")} [dir] [--name <n>] [--port <p>]`,
    `        Bring an EXISTING repo onto the line: Foundation (keeps your docs) -> hive -> register.`,
    `        Safe to re-run; reuses a hive that is still up.`,
    "",
    `  ${c.cyan("watch")} [project] [--agents A,B] [--interval 30] [--stall 15] [--once]`,
    `        The 24/7 supervisor: heal dead agents, run doctor, detect stalls,`,
    `        nudge idle agents, and post an escalation digest to the hive.`,
    "",
    `  ${c.cyan("board")} [--interval 5] [--once]`,
    `        Live control panel: every hive's queue, lanes, done, drift, blockers,`,
    `        and the decisions pending your call.`,
    "",
    `  ${c.cyan("state")} [--compact]            Everything board shows, as JSON (read-only)`,
    `  ${c.cyan("box")} [dir] [--agent claude|codex] [--with A,B] [--fresh] [--memory 4g] [--cpus 2]`,
    `        Run an agent with its permissions skipped, inside a container that`,
    `        mounts one repo and nothing else. Log in once; the fleet home sticks.`,
    `        ${c.dim("--with hands it secrets via comb — never in a command line.")}`,
    `  ${c.cyan("box doctor")} [dir]            Try to read your host secrets from inside the box`,
    "",
    `  ${c.cyan("realms")}                       Machines factory can reach (read from bifrost)`,
    "",
    `  ${c.cyan("decide")} <id> "<your call>"    Answer a pending decision (posts it to the hive)`,
    `  ${c.cyan("briefing")}                     Print the accumulating morning briefing`,
  ].join("\n"));
}

const { flags, pos } = parse(rest);
try {
  switch (cmd) {
    case "new": await factoryNew(pos.join(" ").trim(), flags); break;
    case "adopt": await factoryAdopt(pos[0], flags); break;
    case "watch": await factoryWatch(pos[0], flags); break;
    case "board": await factoryBoard(flags); break;
    case "state": await factoryState(flags); break;
    case "ls": factoryLs(); break;
    case "box": await factoryBox(pos, flags); break;
    case "realms": await factoryRealms(flags); break;
    case "decide": await factoryDecide(pos[0], pos.slice(1)); break;
    case "briefing": await factoryBriefing(); break;
    case "version": case "--version": case "-v": say(`factory ${VERSION}`); break;
    case undefined: case "help": case "--help": case "-h": help(); break;
    default: err(`unknown command: ${cmd}`); help(); process.exit(2);
  }
} catch (e) { err(e.message); process.exit(1); }
