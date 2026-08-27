#!/usr/bin/env node
// factory — The AI Agentic Factory CLI. Phase 1: the Front Door (`new`).
// Coming: `watch` (the standalone 24/7 supervisor), `board` (the control panel).
import { c, say, err } from "./lib/log.mjs";
import { factoryNew } from "./new.mjs";

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
    c.dim("  soon: factory watch <hive>   (24/7 supervisor)   ·   factory board   (live panel)"),
  ].join("\n"));
}

const { flags, pos } = parse(rest);
try {
  switch (cmd) {
    case "new": await factoryNew(pos.join(" ").trim(), flags); break;
    case "version": case "--version": case "-v": say("factory 0.1.0"); break;
    case undefined: case "help": case "--help": case "-h": help(); break;
    default: err(`unknown command: ${cmd}`); help(); process.exit(2);
  }
} catch (e) { err(e.message); process.exit(1); }
