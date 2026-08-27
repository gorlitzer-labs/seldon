// `factory board` — the Control Panel. A live terminal dashboard over every hive the factory knows,
// read straight from the Foundation seam (no room join). See what needs you at a glance; steer with
// the CLI. Read-only.
import { c, say } from "./lib/log.mjs";
import { readRegistry, hiveState } from "./lib/hive.mjs";
import { pending } from "./lib/decisions.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEAR = "\x1b[2J\x1b[H";

export async function factoryBoard(flags) {
  const interval = parseInt(flags.interval || "5", 10) * 1000;
  const once = !!flags.once;
  let stop = false;
  process.on("SIGINT", () => (stop = true));

  const render = async () => {
    const reg = readRegistry();
    const states = await Promise.all(reg.map(hiveState));
    const attention = states.filter(needs).length;
    const out = [];
    out.push(`${c.honey("🏭 The Agentic Factory")}  ${c.dim(new Date().toTimeString().slice(0, 8))}`);
    out.push(c.dim(`  ${states.length} hive(s)${states.length ? ` · ${attention ? c.yellow(attention + " need you") : c.green("all nominal")}` : ""}`));
    out.push("");
    if (states.length === 0) out.push(c.dim("  no hives yet — run: factory new \"<idea>\""));
    for (const s of states) {
      const dot = !s.up ? c.red("●") : needs(s) ? c.yellow("●") : c.green("●");
      const flags2 = [];
      if (!s.up) flags2.push(c.red("DOWN"));
      if (s.drift > 0) flags2.push(c.yellow(`drift ${s.drift}`));
      if (s.blockers > 0) flags2.push(c.red(`${s.blockers} blocker`));
      out.push(`${dot} ${c.bold(s.name.padEnd(22))} ${meter("queue", s.queueOpen)}  ${meter("lanes", s.lanes.length)}  ${meter("done", s.done, c.green)}  ${meter("facts", s.facts)}  ${flags2.join(" ")}`);
      if (s.lanes.length) out.push("   " + s.lanes.map(laneChip).join("  "));
      if (needs(s)) out.push("   " + c.yellow("→ needs you: ") + attentionReasons(s));
      if (s.digest) out.push("   " + c.dim(s.digest.replace(/^\[/, "last [")));
      out.push("");
    }
    const decisions = pending();
    if (decisions.length) {
      out.push(c.yellow(`⚑ ${decisions.length} DECISION(S) PENDING YOUR CALL`));
      for (const d of decisions) {
        out.push(`  ${c.honey(d.id)} ${c.dim(`[${d.hive}]`)} ${c.dim(d.from + ":")} ${d.text.replace(/^\w+:\s*/, "").slice(0, 80)}`);
      }
      out.push(c.dim(`  answer:  factory decide <id> "<your call>"`));
      out.push("");
    }
    out.push(c.dim(once ? "" : `  refreshing every ${interval / 1000}s · ctrl-c to exit`));
    (once ? say : print)(out.join("\n"));
  };

  await render();
  if (once) return;
  while (!stop) { await sleep(interval); if (stop) break; await render(); }
}

const needs = (s) => !s.up || s.drift > 0 || s.blockers > 0;
function attentionReasons(s) {
  const r = [];
  if (!s.up) r.push("hive is down");
  if (s.drift > 0) r.push(`${s.drift} doc↔reality drift`);
  if (s.blockers > 0) r.push(`${s.blockers} blocked lane(s)`);
  return r.join(", ");
}
function laneChip(l) {
  const col = l.status === "blocked" ? c.red : l.status === "done" ? c.green : l.status === "review" ? c.yellow : c.cyan;
  return `${col("▸")} ${l.stream}${c.dim(":")}${col(l.status)}${l.owner && l.owner !== "-" ? c.dim(`(${l.owner})`) : ""}`;
}
function meter(label, n, col = c.cyan) { return `${c.dim(label)} ${col(String(n))}`; }
function print(s) { process.stdout.write(CLEAR + s + "\n"); }
