#!/usr/bin/env node
// foundation — a lean, deterministic project-development workflow.
// Every state mutation goes through these commands; the model never hand-edits the seam.
import { c, say, err } from "./lib/log.mjs";
import { init } from "./init.mjs";
import { doctor } from "./doctor.mjs";
import * as ops from "./commands.mjs";

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

// crude flag/positional split: --flag val, --bool, positionals
function parse(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function help() {
  say([
    c.bold("foundation") + " — deterministic project workflow (the sheet the comb is built on)",
    "",
    c.bold("Usage:") + "  foundation <command> [args] [--dir <repo>]",
    "",
    c.bold("Bootstrap"),
    `  ${c.cyan("init")} [dir]                 Install the seam + doc scaffold into a repo`,
    "",
    c.bold("State (deterministic, concurrency-safe)"),
    `  ${c.cyan("task")} <phase> <token> --done  Flip one checkbox; recompute phase progress`,
    `  ${c.cyan("queue")} "(P1) <text>"          Append an inbound item to QUEUE.md`,
    `  ${c.cyan("stream")} <id> <status> [note]  Upsert one WORKSTREAMS row (your lane)`,
    `  ${c.cyan("done")} "<task>" <ref> [date]   Append a PR-cited line to DONE.md`,
    `  ${c.cyan("fact")} <id> "<claim>" [--verify <cmd>] [--by <who>]`,
    `                              Record a verified fact (tool-stamped)`,
    `  ${c.cyan("decision")} "<title>"           Allocate an ADR number + index row`,
    "",
    c.bold("Read / check"),
    `  ${c.cyan("status")} [dir]                 Phase progress + next queue item (computed)`,
    `  ${c.cyan("versions")} [--all]             Polyglot dep-freshness (exit≠0 on major drift)`,
    `  ${c.cyan("doctor")} [dir]                 Flag doc↔reality drift + ADR reversals (CI)`,
    "",
    c.dim("  every mutation is atomic; the seam grammar is ASCII, validated at write time."),
  ].join("\n"));
}

const { flags, pos } = parse(rest);
const dir = flags.dir || process.cwd();

try {
  switch (cmd) {
    case "init": await init(pos[0] || dir); break;
    case "task": await ops.task(dir, pos, flags); break;
    case "queue": await ops.queue(dir, pos, flags); break;
    case "stream": await ops.stream(dir, pos, flags); break;
    case "done": await ops.done(dir, pos, flags); break;
    case "fact": await ops.fact(dir, pos, flags); break;
    case "decision": await ops.decision(dir, pos, flags); break;
    case "status": await ops.status(pos[0] || dir); break;
    case "versions": await ops.versions(dir, flags); break;
    case "doctor": process.exit(await doctor(pos[0] || dir)); break;
    case "version": case "--version": case "-v": say("foundation 0.1.0"); break;
    case undefined: case "help": case "--help": case "-h": help(); break;
    default: err(`unknown command: ${cmd}`); help(); process.exit(2);
  }
} catch (e) {
  err(e.message);
  process.exit(1);
}
