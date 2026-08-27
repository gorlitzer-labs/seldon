// `factory decide <id> "<your call>"` — answer a pending decision: post it back to the hive so the
// agents unblock, and mark it resolved. The human half of supervised autonomy.
import { readFileSync } from "node:fs";
import { ok, err, say, c } from "./lib/log.mjs";
import { readRegistry } from "./lib/hive.mjs";
import { readDecisions, resolveDecision } from "./lib/decisions.mjs";
import { BRIEFING_PATH } from "./lib/notify.mjs";

export async function factoryDecide(id, answerWords) {
  const answer = answerWords.join(" ").trim();
  if (!id || !answer) throw new Error('usage: factory decide <id> "<your call>"');
  const d = readDecisions().find((x) => x.id === id && x.status === "pending");
  if (!d) throw new Error(`no pending decision "${id}" (see: factory board)`);

  // Post the answer back into the hive so agents unblock.
  const entry = readRegistry().find((e) => e.name === d.hive);
  if (entry?.hive?.serverUrl && entry.hive.adminToken) {
    try {
      const j = await (await fetch(`${entry.hive.serverUrl}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "human", name: "Franco", token: entry.hive.adminToken }) })).json();
      await fetch(`${entry.hive.serverUrl}/message`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${j.sessionToken}` }, body: JSON.stringify({ content: `DECISION ANSWERED [${id}] @${d.from}: ${answer}` }) });
    } catch { err("couldn't reach the hive — resolving locally anyway (agents won't see it until it's back)"); }
  }
  resolveDecision(id, answer);
  ok(`decided ${id}: ${answer}`);
}

export async function factoryBriefing() {
  try { say(readFileSync(BRIEFING_PATH, "utf8").trim() || c.dim("(briefing empty)")); }
  catch { say(c.dim("no briefing yet — the supervisor writes ~/.factory/briefing.md")); }
}
