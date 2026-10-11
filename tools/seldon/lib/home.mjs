// The home screen as data: projects, each with its lanes, most urgent first. Pure — the
// panel in bin/seldon.js only draws these rows and maps keys to them.
//
// A project shows up if it has a running lane OR is registered with factory (it has a plan
// even when nobody is working on it). The two sources are matched by directory.
import { countByState } from "./lanes.mjs";

const URGENT = ["needs-you", "working", "running"];

// `here` is the repo seldon was opened in: always listed, first among the quiet ones, so a
// fresh repo with no agents yet can still get its first lane.
export function buildRows(groups, hives = [], sameDir = (a, b) => a === b, here = null) {
  const projects = groups.map((g) => ({ ...g, hive: hives.find((h) => sameDir(h.dir, g.root)) || null }));
  for (const h of hives) {
    if (!projects.some((p) => sameDir(p.root, h.dir))) projects.push({ root: h.dir, name: h.name, lanes: [], hive: h });
  }
  if (here && !projects.some((p) => sameDir(p.root, here))) projects.push({ root: here, name: here.split("/").pop() || here, lanes: [], hive: null });
  // Active projects keep the urgency order groupByProject gave them; idle registered ones follow.
  const active = projects.filter((p) => p.lanes.some((l) => URGENT.includes(l.state)));
  const isHere = (p) => !!here && sameDir(p.root, here);
  const rest = projects.filter((p) => !active.includes(p)).sort((a, b) => isHere(b) - isHere(a) || a.name.localeCompare(b.name));
  const rows = [];
  for (const p of [...active, ...rest]) {
    rows.push({ type: "project", project: p });
    for (const lane of p.lanes) rows.push({ type: "lane", lane, project: p });
  }
  return rows;
}

export function headline(groups) {
  const c = countByState(groups.flatMap((g) => g.lanes));
  const parts = [];
  if (c["needs-you"]) parts.push(`${c["needs-you"]} need you`);
  const busy = c.working + c.running;
  if (busy) parts.push(`${busy} working`);
  if (c.idle) parts.push(`${c.idle} idle`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.join(" · ") || "no agents running";
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The words after a lane's name: what it is doing, as far as its harness says.
export function laneDetail(lane) {
  if (lane.state === "needs-you") return `needs you: ${lane.waitingFor || "input"}`;
  if (lane.state === "running") return "running (no state reported)";
  return lane.state;
}

// Agents factory knows about that no lane accounts for — e.g. one on another machine, which
// `claude agents` here cannot see. An apiary agent named X runs in tmux session apiary_X.
export function unlistedAgents(project) {
  const names = project.hive?.agents || [];
  return names.filter((n) => !project.lanes.some((l) => l.tmuxSession === `apiary_${n}` || l.name === n));
}

export const GLYPH = { "needs-you": "⚑", working: "●", running: "●", idle: "○", failed: "✗", stopped: "·" };
