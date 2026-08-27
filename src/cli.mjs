#!/usr/bin/env node
// factory — The AI Agentic Factory CLI. Phase 1: the Front Door (`new`).
// Coming: `watch` (the standalone 24/7 supervisor), `board` (the control panel).
import { c, say, err } from "./lib/log.mjs";
import { factoryNew } from "./new.mjs";
import { factoryWatch } from "./watch.mjs";
import { factoryBoard, factoryLs } from "./board.mjs";
import { factoryDecide, factoryBriefing } from "./decide.mjs";

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

function parse(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
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
    `  ${c.cyan("watch")} [project] [--agents A,B] [--interval 30] [--stall 15] [--once]`,
    `        The 24/7 supervisor: heal dead agents, run doctor, detect stalls,`,
    `        nudge idle agents, and post an escalation digest to the hive.`,
    "",
    `  ${c.cyan("board")} [--interval 5] [--once]`,
    `        Live control panel: every hive's queue, lanes, done, drift, blockers,`,
    `        and the decisions pending your call.`,
    "",
    `  ${c.cyan("decide")} <id> "<your call>"    Answer a pending decision (posts it to the hive)`,
    `  ${c.cyan("briefing")}                     Print the accumulating morning briefing`,
  ].join("\n"));
}

const { flags, pos } = parse(rest);
try {
  switch (cmd) {
    case "new": await factoryNew(pos.join(" ").trim(), flags); break;
    case "watch": await factoryWatch(pos[0], flags); break;
    case "board": await factoryBoard(flags); break;
    case "ls": factoryLs(); break;
    case "decide": await factoryDecide(pos[0], pos.slice(1)); break;
    case "briefing": await factoryBriefing(); break;
    case "version": case "--version": case "-v": say("factory 0.1.0"); break;
    case undefined: case "help": case "--help": case "-h": help(); break;
    default: err(`unknown command: ${cmd}`); help(); process.exit(2);
  }
} catch (e) { err(e.message); process.exit(1); }
