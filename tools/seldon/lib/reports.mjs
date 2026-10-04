// Harness reports: Codex and opencode telling seldon what they are doing.
//
// Claude Code lists its own sessions (`claude agents --json`). Codex and opencode do not, but
// both run code on their own lifecycle events — Codex command hooks, opencode plugins — and
// both hand that code a JSON event. `seldon setup` installs a tiny hook/plugin that pipes the
// event to `seldon report <harness>`, which keeps one small state file per session. This file
// is the one place an event becomes a state, for both harnesses. Pure.
//   Codex hooks:      https://learn.chatgpt.com/docs/hooks
//   opencode plugins: https://opencode.ai/docs/plugins/

// Codex hook event -> state. Interrupt and Stop both end the turn.
const CODEX = {
  SessionStart: "idle", UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
  SubagentStart: "working", PermissionRequest: "needs-you", Stop: "idle", Interrupt: "idle",
};

export function reportFromEvent(harness, ev, now = Date.now()) {
  if (!ev || typeof ev !== "object") return null;
  if (harness === "codex") {
    const name = ev.hook_event_name;
    if (name === "SessionEnd") return { harness, session: ev.session_id, cwd: ev.cwd, ended: true, at: now };
    const state = CODEX[name];
    if (!state || !ev.session_id) return null;
    return { harness, session: ev.session_id, cwd: ev.cwd, state, waitingFor: state === "needs-you" ? `permission: ${ev.tool_name || "tool"}` : null, at: now };
  }
  if (harness === "opencode") {
    // The plugin adds `cwd` (its directory); opencode events carry properties.sessionID.
    const p = ev.properties || {};
    const session = p.sessionID || p.info?.sessionID || p.info?.id;
    if (!session) return null;
    const base = { harness, session, cwd: ev.cwd, at: now };
    switch (ev.type) {
      case "session.status": {
        const t = p.status?.type;
        return t === "busy" || t === "retry" ? { ...base, state: "working" } : t === "idle" ? { ...base, state: "idle" } : null;
      }
      case "session.idle": return { ...base, state: "idle" };
      case "permission.asked": return { ...base, state: "needs-you", waitingFor: `permission: ${p.permission || p.type || "tool"}` };
      case "permission.replied": return { ...base, state: "working" };
      case "session.error": return { ...base, state: "failed" };
      case "session.deleted": return { ...base, ended: true };
      default: return null;
    }
  }
  return null;
}

// The opencode events worth a report — the plugin forwards only these, so the stream of
// message.part.updated events never spawns anything.
export const OPENCODE_EVENTS = ["session.status", "session.idle", "permission.asked", "permission.replied", "session.error", "session.deleted"];

// Give each tmux lane the newest report from its own worktree. A lane with no report keeps
// "running"; a report older than the lane (left by an earlier session there) is ignored.
export function applyReports(lanes, reports, sameDir = (a, b) => a === b) {
  return lanes.map((l) => {
    if (l.kind !== "tmux" || l.state === "stopped") return l;
    const mine = reports.filter((r) => r.harness === l.harness && r.cwd && sameDir(r.cwd, l.cwd) && (!l.startedAt || r.at >= l.startedAt - 5000));
    if (!mine.length) return l;
    const r = mine.reduce((a, b) => (b.at > a.at ? b : a));
    return { ...l, state: r.state, waitingFor: r.waitingFor ?? null };
  });
}

// ---- setup: what seldon installs into each harness ---------------------------------------
const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt"];
// Every command seldon installs starts with this, so it can find its own hooks again (and only
// its own) whatever path the seldon binary has.
export const SELDON_MARK = "SELDON_REPORT=1";

// A hook event's matcher groups with seldon's handlers taken out (and groups left empty dropped).
const withoutSeldon = (groups = []) => groups
  .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || "").includes(SELDON_MARK)) }))
  .filter((g) => g.hooks.length);

// Merge seldon's hooks into an existing Codex hooks.json, leaving everything else alone.
// Idempotent: an existing seldon handler is replaced, never duplicated.
export function mergeCodexHooks(existing, command) {
  const cfg = existing && typeof existing === "object" ? structuredClone(existing) : {};
  cfg.hooks = cfg.hooks || {};
  for (const ev of HOOK_EVENTS) {
    const groups = withoutSeldon(cfg.hooks[ev]);
    groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    cfg.hooks[ev] = groups;
  }
  return cfg;
}

export function removeCodexHooks(existing) {
  if (!existing?.hooks) return existing;
  const cfg = structuredClone(existing);
  for (const ev of Object.keys(cfg.hooks)) {
    cfg.hooks[ev] = withoutSeldon(cfg.hooks[ev]);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  return cfg;
}

// The opencode plugin: forward the few events that change state to `seldon report opencode`,
// adding the directory (opencode events do not carry it). Never throws into opencode.
export function opencodePlugin(seldon) {
  return `// Installed by \`seldon setup opencode\` — tells seldon what this opencode session is doing.
// Remove with \`seldon setup opencode --remove\`.
import { spawn } from "node:child_process";
const FORWARD = new Set(${JSON.stringify(OPENCODE_EVENTS)});
export const SeldonReport = async ({ directory }) => ({
  event: async ({ event }) => {
    if (!FORWARD.has(event?.type)) return;
    try {
      const p = spawn(${JSON.stringify(seldon)}, ["report", "opencode"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
      p.stdin.end(JSON.stringify({ ...event, cwd: directory }));
      p.unref();
    } catch {}
  },
});
`;
}
