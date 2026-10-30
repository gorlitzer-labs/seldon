// `seldon serve` — the panel as a phone app. Same lanes, same actions, a touch screen instead of
// a terminal. It owns nothing: it reads what the panel reads (readLanes, bifrost's machines) and
// acts through the same functions `seldon lane …` uses, locally or over `ssh <machine> seldon …`.
//
// Reach it from a phone with `tailscale serve`: HTTPS, the tailnet's identity on every request,
// no port on the internet. On its own it listens on loopback only.
//
// Pure rules first (tested without a server), then the I/O.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readLanes, readPlan, addToPlan, projectRoot } from "./agents.mjs";
import { startLane, stopLane, resumeLane, removeLane, findLane, allLanes } from "./actions.mjs";
import { listMachines, fetchLanes, remoteGroups, sshArgs } from "./machines.mjs";
import { listHolds } from "./holds-store.mjs";
import { headline } from "./home.mjs";
import { HARNESSES, laneForItem, stopCommand, resumeCommands } from "./lanes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- pure ---------------------------------------------------------------------------
// "mini/claude:ab12" → { machine: "mini", key: "claude:ab12" }; local keys have no slash.
export function splitKey(key) {
  const s = String(key || "");
  const i = s.indexOf("/");
  return i > 0 && !s.slice(0, i).includes(":") ? { machine: s.slice(0, i), key: s.slice(i + 1) } : { machine: null, key: s };
}

// Who may talk to it. Loopback and tailnet names only (a DNS-rebinding page can't pose as
// either), every write carries a header a cross-site form can't set, and with --owner the
// identity tailscale serve stamps on the request must be that login.
export function guard({ method, host, headers }, { owner = null } = {}) {
  const h = String(host || "").replace(/:\d+$/, "").toLowerCase();
  if (!(h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".ts.net"))) return "host not allowed";
  if (owner && headers["tailscale-user-login"] !== owner) return "not the owner";
  if (method !== "GET" && headers["x-seldon"] !== "1") return "missing x-seldon header";
  return null;
}

// Keys a phone may press into an agent. A whitelist, so a reply can't smuggle tmux syntax.
export const REPLY_KEYS = { enter: "Enter", esc: "Escape", up: "Up", down: "Down", tab: "Tab", "ctrl-c": "C-c" };
// `submit: false` types without Enter: a menu key ("1") already chooses, and an Enter after it
// would answer whatever the agent asks next.
export function replyArgs(session, { key, text, submit = true } = {}) {
  if (!session) return null;
  if (key && REPLY_KEYS[key]) return [["send-keys", "-t", session, REPLY_KEYS[key]]];
  if (typeof text === "string" && text.length && text.length <= 2000)
    return [["send-keys", "-t", session, "-l", text], ...(submit ? [["send-keys", "-t", session, "Enter"]] : [])];
  return null;
}

// What a phone can do with a lane, so the UI never offers a button the server will refuse.
export function laneCaps(lane) {
  const live = !["stopped", "failed"].includes(lane.state);
  return {
    peek: !!lane.tmuxSession && live,
    reply: !!lane.tmuxSession && live,
    stop: live && !stopCommand(lane).why,
    resume: !live && !resumeCommands(lane).why,
    rm: !live,
    // Claude background lanes live under Claude's own supervisor: no tmux pane to read.
    // Claude's Remote Control (claude.ai/code, the Claude app) is the way in for those.
    hint: !lane.tmuxSession && lane.harness === "claude" && live
      ? (lane.id ? `claude attach ${lane.id}` : "open it in its terminal, or with Claude Remote Control") : null,
  };
}

// ---- I/O ----------------------------------------------------------------------------
const sh = (bin, args, timeout = 10_000) => new Promise((res) =>
  execFile(bin, args, { timeout, encoding: "utf8", maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
    res({ ok: !err, out: stdout || "", error: err ? (String(stderr).trim().split("\n").pop() || err.message) : null })));

// Machines are asked in the background, like the panel does, so a sleeping one never stalls a
// request. The cache is what the API answers from.
function remoteCache(intervalMs = 10_000) {
  const state = new Map();     // name → { machine, lanes, error, at }
  const poll = () => {
    for (const m of listMachines()) fetchLanes(m, (r) => state.set(m.name, { machine: m, ...r, at: Date.now() }));
  };
  poll();
  const t = setInterval(poll, intervalMs); t.unref();
  return {
    groups: () => [...state.values()].filter((s) => s.lanes).flatMap((s) => remoteGroups({ ...s.machine }, s.lanes)),
    machines: () => listMachines().map((m) => {
      const s = state.get(m.name);
      return { name: m.name, host: m.host, ok: !!s?.lanes, error: s?.error || (s ? null : "asking…"), count: s?.lanes?.length ?? 0, at: s?.at ?? null };
    }),
    get: (name) => state.get(name),
    refresh: poll,
  };
}

function snapshot(remote) {
  const local = readLanes().map((g) => ({ ...g, machine: null }));
  const groups = [...local, ...remote.groups()];
  for (const g of groups) for (const l of g.lanes) l.caps = laneCaps(l);
  return { headline: headline(groups), groups, machines: remote.machines(), holds: listHolds(), at: Date.now() };
}

function laneByKey(remote, fullKey) {
  const { machine, key } = splitKey(fullKey);
  if (!machine) { const lane = findLane(key); return lane ? { lane, machine: null } : null; }
  const s = remote.get(machine);
  const lane = s?.lanes?.find((l) => l.key === key);
  return lane ? { lane, machine: s.machine } : null;
}

// One verb, wherever the lane lives.
async function act(remote, verb, fullKey, opts = {}) {
  const found = laneByKey(remote, fullKey);
  if (!found) return { ok: false, error: "no such lane (it may have just ended)" };
  const { lane, machine } = found;
  if (machine) {
    const r = await sh("ssh", sshArgs(machine, ["seldon", "lane", verb, lane.key, ...(opts.force ? ["--force"] : [])]), 30_000);
    remote.refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  const r = verb === "stop" ? stopLane(lane) : verb === "resume" ? resumeLane(lane) : removeLane(lane, { force: !!opts.force });
  return r.why ? { ok: false, error: r.why } : r;
}

async function tmuxOn(machine, args) {
  return machine ? sh("ssh", sshArgs(machine, ["tmux", ...args])) : sh("tmux", args);
}

async function peek(remote, fullKey, lines = 60) {
  const found = laneByKey(remote, fullKey);
  if (!found?.lane.tmuxSession) return { ok: false, error: "no screen to read for this lane" };
  const r = await tmuxOn(found.machine, ["capture-pane", "-p", "-J", "-t", found.lane.tmuxSession, "-S", `-${Math.min(400, lines)}`]);
  return r.ok ? { ok: true, screen: r.out.replace(/\s+$/, "") } : r;
}

async function reply(remote, fullKey, body) {
  const found = laneByKey(remote, fullKey);
  const steps = replyArgs(found?.lane.tmuxSession, body);
  if (!steps) return { ok: false, error: "nothing to send, or no pane to send it to" };
  for (const args of steps) { const r = await tmuxOn(found.machine, args); if (!r.ok) return r; }
  return { ok: true };
}

async function start(remote, { root, machine, task, agent = "claude" }) {
  if (!HARNESSES.includes(agent)) return { ok: false, error: `unknown agent ${agent}` };
  if (machine) {
    const m = remote.get(machine)?.machine;
    if (!m) return { ok: false, error: `unknown machine ${machine}` };
    const r = await sh("ssh", sshArgs(m, ["seldon", "lane", "start", root, "--task", task, "--agent", agent]), 30_000);
    remote.refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  const dir = projectRoot(root) || root;
  return startLane({ root: dir, name: dir.split("/").pop(), task, harness: agent });
}

// The open plan, each item with the lane already on it (the panel's own matching rule).
async function plan(remote, { root, machine }) {
  const withLanes = (items, lanes) => items && items.map((it) => ({ ...it, lane: laneForItem(it, lanes)?.name ?? null }));
  if (!machine) return { ok: true, items: withLanes(readPlan(root), allLanes()) };
  const s = remote.get(machine);
  if (!s) return { ok: false, error: `unknown machine ${machine}` };
  const r = await sh("ssh", sshArgs(s.machine, ["foundation", "queue", "--list", "--json", "--dir", root]));
  const line = r.out.split("\n").reverse().find((l) => l.trim().startsWith("["));
  try { return { ok: true, items: withLanes(line ? JSON.parse(line) : null, s.lanes || []) }; } catch { return { ok: true, items: null }; }
}

const readBody = (req) => new Promise((res) => {
  let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
  req.on("end", () => { try { res(JSON.parse(raw || "{}")); } catch { res({}); } });
});

export function serve({ port = 7930, owner = null, allowReply = false } = {}) {
  const remote = remoteCache();
  const page = () => readFileSync(join(HERE, "web", "index.html"), "utf8");   // re-read: edit + reload
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const denied = guard({ method: req.method, host: req.headers.host, headers: req.headers }, { owner });
    if (denied) return send(res, 403, { ok: false, error: denied });
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page(), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/manifest.webmanifest")
        return send(res, 200, JSON.stringify({ name: "seldon", short_name: "seldon", display: "standalone", start_url: "/", background_color: "#0e0f0c", theme_color: "#0e0f0c" }), "application/manifest+json");
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, { ...snapshot(remote), allowReply });
      if (req.method === "GET" && url.pathname === "/api/peek") return send(res, 200, await peek(remote, url.searchParams.get("key")));
      if (req.method === "GET" && url.pathname === "/api/plan")
        return send(res, 200, await plan(remote, { root: url.searchParams.get("root"), machine: url.searchParams.get("machine") || null }));
      if (req.method === "POST") {
        const body = await readBody(req);
        const m = url.pathname.match(/^\/api\/lane\/(stop|resume|rm)$/);
        if (m) return send(res, 200, await act(remote, m[1], body.key, body));
        if (url.pathname === "/api/lane/start") return send(res, 200, await start(remote, body));
        if (url.pathname === "/api/lane/reply") {
          if (!allowReply) return send(res, 403, { ok: false, error: "replies are off — start with: seldon serve --allow-reply" });
          return send(res, 200, await reply(remote, body.lane, body));
        }
        if (url.pathname === "/api/plan/add" && !body.machine && body.root && body.text)
          return send(res, 200, addToPlan(body.root, String(body.text).slice(0, 500), body.priority || "P2"));
      }
      send(res, 404, { ok: false, error: "not found" });
    } catch (e) { send(res, 500, { ok: false, error: e.message }); }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
