// `factory watch <project>` — the Supervisor. A standalone daemon (independent of any Claude Code
// session) that keeps ONE hive alive and productive under SUPERVISED autonomy:
//   feed · heal · check · stall-detect · digest → escalate to the human, never decide the irreversible.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { c, say, ok, warn, err } from "./lib/log.mjs";

const sh = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }); } catch { return null; } };
// Like sh() but returns stdout even on a non-zero exit (e.g. `foundation doctor` exits 1 on drift).
const shOut = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }); } catch (e) { return (e.stdout || "").toString(); } };
const tmuxAlive = (name) => sh("tmux", ["has-session", "-t", `apiary_${name}`]) !== null;
const nowHM = () => new Date().toTimeString().slice(0, 5);

export async function factoryWatch(project, flags) {
  const dir = project ? require_resolve(project) : process.cwd();
  const facPath = join(dir, ".factory.json");
  if (!existsSync(facPath)) throw new Error(`no .factory.json in ${dir} — run \`factory new\` there first`);
  const { name, hive } = JSON.parse(readFileSync(facPath, "utf8"));
  const roster = (flags.agents ? String(flags.agents).split(",") : []).map((s) => s.trim()).filter(Boolean);
  const interval = parseInt(flags.interval || "30", 10) * 1000;
  const stallMs = parseInt(flags.stall || "15", 10) * 60000;
  const once = !!flags.once;
  const digestPath = join(dir, ".factory", "digest.log");
  mkdirSync(join(dir, ".factory"), { recursive: true });

  say(`${c.honey("🏭 supervisor")} watching ${c.bold(name)} ${c.dim(`(${hive?.serverUrl || "no hive"})`)}`);
  say(c.dim(`  roster: ${roster.join(", ") || "(none declared — heal disabled)"}  ·  interval ${interval / 1000}s  ·  stall ${stallMs / 60000}m`));

  const stok = hive ? await joinAsSupervisor(hive) : null;
  let lastFingerprint = null, lastProgressAt = Date.now(), lastDigestAt = 0, nudgedIdle = false;
  let stop = false;
  const leave = () => { stop = true; };
  process.on("SIGINT", leave); process.on("SIGTERM", leave);

  const tick = async () => {
    const events = [];
    // ── HEAL: respawn any rostered agent whose tmux session is gone ──
    for (const a of roster) {
      if (!tmuxAlive(a)) {
        respawn(a, hive, dir);
        events.push(`healed: respawned dead agent ${a}`);
      }
    }
    // ── PRESENCE ──
    const online = stok ? await getOnline(hive, stok) : [];
    // ── SEAM STATE ──
    const doctor = shOut("foundation", ["doctor", "--dir", dir]);
    const drift = (doctor.match(/(\d+) drift issue/)?.[1]) || (doctor.includes("no drift") ? "0" : "?");
    const queueOpen = countMatch(readSafe(join(dir, "docs", "QUEUE.md")), /^- \[ \] /gm);
    const doneCount = countMatch(readSafe(join(dir, "docs", "DONE.md")), /^- \[x\] /gm);
    const wsRows = readSafe(join(dir, "docs", "WORKSTREAMS.md")).split("\n")
      .filter((l) => /^\|\s/.test(l) && !/stream\s*\|/i.test(l) && !/^\|\s*-/.test(l)).length;
    // ── NUDGE: online agents but open queue and no lanes → point them at the work (once) ──
    if (stok && queueOpen > 0 && online.some((n) => !roster.includes(n) || true) && wsRows === 0 && online.length > 1) {
      if (!nudgedIdle) { await postMsg(hive, stok, `FYI: ${queueOpen} item(s) in the QUEUE and no active lanes yet. Run /orient, claim one, and register your lane with \`foundation stream\`.`); events.push("nudged idle agents toward the queue"); nudgedIdle = true; }
    } else if (wsRows > 0) nudgedIdle = false;
    // ── STALL ──
    const fp = `${doneCount}|${queueOpen}|${wsRows}|${mtime(join(dir, "docs", "WORKSTREAMS.md"))}`;
    if (fp !== lastFingerprint) { lastFingerprint = fp; lastProgressAt = Date.now(); }
    const stalledMin = Math.floor((Date.now() - lastProgressAt) / 60000);
    const stalled = Date.now() - lastProgressAt >= stallMs;
    if (stalled) events.push(`STALL: no progress in ${stalledMin}m — needs you`);
    if (drift !== "0" && drift !== "?") events.push(`DRIFT: ${drift} doc↔reality issue(s) — foundation doctor`);
    // ── DIGEST (throttled, or on any escalation event) ──
    const escalate = events.some((e) => /STALL|DRIFT|BLOCKER/.test(e));
    const digestDue = Date.now() - lastDigestAt >= parseInt(flags.digest || "60", 10) * 60000;
    const line = `[${nowHM()}] ${name}: queue ${queueOpen} open · ${doneCount} done · ${wsRows} lanes · ${online.length} online · drift ${drift}${stalled ? ` · STALLED ${stalledMin}m` : ""}`;
    say(`  ${stalled || escalate ? c.yellow(line) : c.dim(line)}`);
    for (const e of events) say(`    ${c.honey("→")} ${e}`);
    if (once || digestDue || escalate) {
      appendFileSync(digestPath, line + (events.length ? "\n  " + events.join("\n  ") : "") + "\n");
      if (stok && (digestDue || escalate)) {
        const needs = events.filter((e) => /STALL|DRIFT|BLOCKER|healed/.test(e));
        await postMsg(hive, stok, `SUPERVISOR DIGEST — ${line.replace(/^\[.*?\] /, "")}` + (needs.length ? `\nNeeds you:\n- ${needs.join("\n- ")}` : `\nAll nominal.`));
        lastDigestAt = Date.now();
      }
    }
  };

  await tick();
  if (once) { ok("single tick complete (--once)"); return; }
  while (!stop) {
    await sleep(interval);
    if (stop) break;
    try { await tick(); } catch (e) { warn(`tick error: ${e.message}`); }
  }
  say(c.dim("supervisor stopped."));
}

// ── helpers ──
function require_resolve(p) { const abs = p.startsWith("/") ? p : join(process.cwd(), p); return abs.replace(/^~/, homedir()); }
const readSafe = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const countMatch = (s, re) => (s.match(re) || []).length;
const mtime = (p) => (existsSync(p) ? Math.floor(statSync(p).mtimeMs) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function joinAsSupervisor(hive) {
  try {
    const r = await fetch(`${hive.serverUrl}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "human", name: "Supervisor", token: hive.adminToken }) });
    const d = await r.json(); return d.sessionToken || null;
  } catch { return null; }
}
async function getOnline(hive, stok) {
  try { const r = await fetch(`${hive.serverUrl}/participants`, { headers: { Authorization: `Bearer ${stok}` } }); const d = await r.json(); return (d.participants || []).map((p) => p.name); } catch { return []; }
}
async function postMsg(hive, stok, content) {
  try { await fetch(`${hive.serverUrl}/message`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${stok}` }, body: JSON.stringify({ content }) }); } catch { /* best effort */ }
}
function respawn(name, hive, dir) {
  try {
    mkdirSync(join(homedir(), ".apiary", "invites"), { recursive: true });
    writeFileSync(join(homedir(), ".apiary", "invites", name), `${hive.serverUrl}/?token=${hive.adminToken}`);
    const child = spawn("apiary", ["claude", name, "--admin", "--background"], { cwd: dir, detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort */ }
}
