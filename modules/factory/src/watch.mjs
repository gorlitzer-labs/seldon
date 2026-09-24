// `factory watch <project>` / `factory watch --all` — the Supervisor. A standalone daemon
// (independent of any Claude Code session) that keeps hives alive + productive under SUPERVISED
// autonomy: feed · heal · check · stall-detect · escalate. One hive, or every registered hive.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { c, say, ok, warn } from "./lib/log.mjs";
import { notify, brief } from "./lib/notify.mjs";
import { fileDecision } from "./lib/decisions.mjs";
import { readRegistry, isLiveHive } from "./lib/hive.mjs";
import { resolveRealm, runnerArgv } from "./lib/realm.mjs";
import { shOut, readSafe, count } from "./lib/util.mjs";

// Is an agent's tmux session alive? Locally when the hive has no realm, else
// over ssh to the realm — the check is the same, only the machine differs.
const tmuxAliveOn = (realm, name) => {
  const { bin, args } = runnerArgv(realm, ["tmux", "has-session", "-t", `apiary_${name}`]);
  try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; }
};
const nowHM = () => new Date().toTimeString().slice(0, 5);
const mtime = (p) => (existsSync(p) ? Math.floor(statSync(p).mtimeMs) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function factoryWatch(project, flags) {
  // --all skips dead entries: supervising them re-created their folders and respawned agents there.
  // It also re-reads the registry every tick (below), so an empty registry is a wait, not an error.
  const entries = flags.all ? readRegistry().filter(isLiveHive) : [singleEntry(project)];
  if (!flags.all && !entries[0]) throw new Error("no .factory.json here — pass a project or use --all");
  const interval = parseInt(flags.interval || "30", 10) * 1000;
  const roster = (flags.agents ? String(flags.agents).split(",") : []).map((s) => s.trim()).filter(Boolean);

  say(`${c.honey("🏭 supervisor")} watching ${c.bold(entries.length === 1 ? entries[0].name : `${entries.length} hives`)}${flags.all ? c.dim(" (and any adopted later)") : ""}  ${c.dim(`· interval ${interval / 1000}s · stall ${parseInt(flags.stall || "15", 10)}m`)}`);
  let sups = [];
  for (const e of entries) sups.push({ dir: e.dir, ...(await makeSupervisor(e, flags, roster)) });

  // --all: pick up hives adopted/created after start, drop ones that died. Without this a
  // `factory adopt` after `seldon up` was silently unsupervised until the next restart.
  const refresh = async () => {
    if (!flags.all) return;
    const live = readRegistry().filter(isLiveHive);
    const dirs = new Set(live.map((e) => e.dir));
    const dropped = sups.filter((s) => !dirs.has(s.dir));
    sups = sups.filter((s) => dirs.has(s.dir));
    for (const s of dropped) say(c.dim(`supervisor: ${s.name} is gone — no longer watching`));
    for (const e of live) {
      if (sups.some((s) => s.dir === e.dir)) continue;
      try { sups.push({ dir: e.dir, ...(await makeSupervisor(e, flags, roster)) }); ok(`supervisor: now watching ${e.name}`); }
      catch (err) { warn(`${e.name}: could not start supervising — ${err.message}`); }
    }
  };

  const once = !!flags.once;
  let stop = false;
  const leave = () => { stop = true; };
  process.on("SIGINT", leave); process.on("SIGTERM", leave);
  const tickAll = async () => { for (const s of sups) { try { await s.tick(); } catch (e) { warn(`${s.name}: tick error ${e.message}`); } } };

  await tickAll();
  if (once) { ok(`single tick complete (--once) · ${sups.length} hive(s)`); return; }
  while (!stop) { await sleep(interval); if (stop) break; await refresh(); await tickAll(); }
  say(c.dim("supervisor stopped."));
}

function singleEntry(project) {
  const dir = project ? (project.startsWith("/") ? project : join(process.cwd(), project)).replace(/^~/, homedir()) : process.cwd();
  const p = join(dir, ".factory.json");
  if (!existsSync(p)) return null;
  const { name, hive } = JSON.parse(readFileSync(p, "utf8"));
  return { name, dir, hive };
}

// One self-contained supervisor for a single hive — its own state + its own tick.
async function makeSupervisor(entry, flags, roster) {
  const { name, dir, hive } = entry;
  const stallMs = parseInt(flags.stall || "15", 10) * 60000;
  const digestMs = parseInt(flags.digest || "60", 10) * 60000;
  const digestPath = join(dir, ".factory", "digest.log");
  mkdirSync(join(dir, ".factory"), { recursive: true });
  const stok = hive ? await join_(hive) : null;
  let lastFp = null, lastProgressAt = Date.now(), lastDigestAt = 0, nudged = false;

  const tick = async () => {
    const events = [];
    const realm = entry.realm ? resolveRealm(entry.realm) : null;
    for (const a of roster) if (!tmuxAliveOn(realm, a)) { respawn(a, hive, dir, realm); events.push(`healed: respawned dead agent ${a}${realm ? ` on ${entry.realm}` : ""}`); }
    const online = stok ? await getOnline(hive, stok) : [];
    if (stok) {
      for (const m of await getMessages(hive, stok)) {
        const t = (m.content || "").trim();
        const kind = t.startsWith("DECISION:") ? "decision" : t.startsWith("BLOCKER:") ? "blocker" : null;
        if (!kind || m.sender_name === "Supervisor") continue;
        const filed = fileDecision({ hive: name, dir, from: m.sender_name, text: t.slice(0, 200), kind, ts: nowHM() });
        if (filed) {
          events.push(`${kind.toUpperCase()} from ${m.sender_name} — needs your call (factory decide ${filed.id})`);
          notify(`Factory · ${kind} in ${name}`, `${m.sender_name}: ${t.replace(/^\w+:\s*/, "").slice(0, 90)}`);
          brief(`[${name}] ${kind} from ${m.sender_name}: ${t.slice(0, 130)}  (factory decide ${filed.id})`);
        }
      }
    }
    const doctor = shOut("foundation", ["doctor", "--dir", dir]);
    const drift = doctor.includes("no drift") ? "0" : (doctor.match(/(\d+) drift issue/)?.[1] || "?");
    const queueOpen = count(readSafe(join(dir, "docs", "QUEUE.md")), /^- \[ \] /gm);
    const doneCount = count(readSafe(join(dir, "docs", "DONE.md")), /^- \[x\] /gm);
    const wsRows = readSafe(join(dir, "docs", "WORKSTREAMS.md")).split("\n").filter((l) => /^\|\s/.test(l) && !/stream\s*\|/i.test(l) && !/^\|\s*-/.test(l)).length;
    if (stok && queueOpen > 0 && wsRows === 0 && online.length > 1) {
      if (!nudged) { await postMsg(hive, stok, `FYI: ${queueOpen} item(s) in the QUEUE and no active lanes. Run /orient, claim one, register your lane.`); events.push("nudged idle agents toward the queue"); nudged = true; }
    } else if (wsRows > 0) nudged = false;
    const fp = `${doneCount}|${queueOpen}|${wsRows}|${mtime(join(dir, "docs", "WORKSTREAMS.md"))}`;
    if (fp !== lastFp) { lastFp = fp; lastProgressAt = Date.now(); }
    const stalledMin = Math.floor((Date.now() - lastProgressAt) / 60000);
    const stalled = Date.now() - lastProgressAt >= stallMs;
    if (stalled) events.push(`STALL: no progress in ${stalledMin}m — needs you`);
    if (drift !== "0" && drift !== "?") events.push(`DRIFT: ${drift} doc↔reality issue(s)`);

    const escalate = events.some((e) => /STALL|DRIFT|BLOCKER|DECISION/.test(e));
    const line = `[${nowHM()}] ${name}: queue ${queueOpen} · ${doneCount} done · ${wsRows} lanes · ${online.length} online · drift ${drift}${stalled ? ` · STALLED ${stalledMin}m` : ""}`;
    say(`  ${stalled || escalate ? c.yellow(line) : c.dim(line)}`);
    for (const e of events) say(`    ${c.honey("→")} ${e}`);

    const digestDue = Date.now() - lastDigestAt >= digestMs;
    if (flags.once || digestDue || escalate) {
      appendFileSync(digestPath, line + (events.length ? "\n  " + events.join("\n  ") : "") + "\n");
      if (stok && (digestDue || escalate)) {
        const needs = events.filter((e) => /STALL|DRIFT|BLOCKER|DECISION|healed/.test(e));
        await postMsg(hive, stok, `SUPERVISOR DIGEST — ${line.replace(/^\[.*?\] /, "")}` + (needs.length ? `\nNeeds you:\n- ${needs.join("\n- ")}` : `\nAll nominal.`));
        if (escalate) { notify(`Factory · ${name} needs you`, needs[0] || line); brief(`[${name}] escalation: ${needs.join("; ") || line}`); }
        lastDigestAt = Date.now();
      }
    }
  };
  return { name, tick };
}

// ── hive HTTP + respawn ──
async function join_(hive) {
  try { const d = await (await fetch(`${hive.serverUrl}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "human", name: "Supervisor", token: hive.adminToken }) })).json(); return d.sessionToken || null; } catch { return null; }
}
async function getOnline(hive, stok) { try { const d = await (await fetch(`${hive.serverUrl}/participants`, { headers: { Authorization: `Bearer ${stok}` } })).json(); return (d.participants || []).map((p) => p.name); } catch { return []; } }
async function getMessages(hive, stok) { try { const d = await (await fetch(`${hive.serverUrl}/messages`, { headers: { Authorization: `Bearer ${stok}` } })).json(); return d.items || []; } catch { return []; } }
async function postMsg(hive, stok, content) { try { await fetch(`${hive.serverUrl}/message`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${stok}` }, body: JSON.stringify({ content }) }); } catch {} }
function respawn(name, hive, dir, realm = null) {
  try {
    if (realm) {
      // On a realm, the invite and the apiary launch both happen there. The
      // agent joins the same hive URL — a tailnet address reachable from either
      // machine — so a realm agent lands in exactly the same room as a local one.
      const url = `${hive.serverUrl}/?token=${hive.adminToken}`;
      const remote = `mkdir -p ~/.apiary/invites && printf %s ${JSON.stringify(url)} > ~/.apiary/invites/${name} && apiary claude ${name} --admin --background`;
      const { bin, args } = runnerArgv(realm, ["sh", "-c", JSON.stringify(remote)]);
      spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
      return;
    }
    mkdirSync(join(homedir(), ".apiary", "invites"), { recursive: true });
    writeFileSync(join(homedir(), ".apiary", "invites", name), `${hive.serverUrl}/?token=${hive.adminToken}`);
    spawn("apiary", ["claude", name, "--admin", "--background"], { cwd: dir, detached: true, stdio: "ignore" }).unref();
  } catch {}
}
