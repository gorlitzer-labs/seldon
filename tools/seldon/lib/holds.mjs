// Holds: turn-taking on things one machine has only one of.
//
// Agents on different projects share the machine: one boots the Android emulator, another
// opens Unreal, a third runs the GPU benchmark, and they trip over each other. Rooms do not
// help — they are per project, and agents on different repos never meet. A hold is the
// smallest thing that does: before using a shared resource an agent runs `seldon hold
// emulator`; if someone else holds it, the command waits its turn; `seldon release emulator`
// when done.
//
// A hold can never wedge the machine: it expires when its time is up, or as soon as the agent
// that took it has exited. This file is the rules, pure; holds-store.mjs does the files.

export const DEFAULT_FOR_MS = 30 * 60_000;     // a hold lasts 30 min unless renewed
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export function parseDuration(s, fallback) {
  if (s === undefined || s === true) return fallback;
  const m = String(s).match(/^(\d+)(s|m|h)?$/);
  if (!m) return null;
  return Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2] || "m"]);
}

// Is this hold still in force? `alive(pid)` is injected.
export function isLive(hold, now, alive) {
  if (!hold) return false;
  if (hold.until <= now) return false;
  if (hold.pid && !alive(hold.pid)) return false;
  return true;
}

const sameHolder = (a, b) => (a.pid && b.pid ? a.pid === b.pid : a.who === b.who);

// What happens when `me` asks for a resource currently `held` (or null).
//   { take: hold }        it is free, expired, abandoned, or already mine (renewed)
//   { wait: held }        someone else has it
export function decide(held, me, now, alive) {
  if (!isLive(held, now, alive) || sameHolder(held, me)) {
    return { take: { ...me, since: held && sameHolder(held, me) && isLive(held, now, alive) ? held.since : now, until: now + me.forMs } };
  }
  return { wait: held };
}

// May `me` release `held`? Only its holder, unless forced; a dead hold is anyone's to clear.
export function mayRelease(held, me, now, alive, force = false) {
  if (!held) return { ok: true, gone: true };
  if (force || !isLive(held, now, alive) || sameHolder(held, me)) return { ok: true };
  return { ok: false, held };
}

// The agent a `seldon hold` belongs to: the nearest ancestor that is an agent CLI. `seldon`
// itself exits right after taking the hold, so its own pid would make every hold look
// abandoned. Falls back to null (the hold then lives by its timer alone).
const AGENTS = new Set(["claude", "codex", "opencode"]);
export function ownerPid(startPid, parentOf, nameOf, maxDepth = 8) {
  let pid = startPid;
  for (let i = 0; pid && pid > 1 && i < maxDepth; i++) {
    const name = (nameOf(pid) || "").split("/").pop();
    if (AGENTS.has(name)) return pid;
    pid = parentOf(pid);
  }
  return null;
}

export function describe(hold, now) {
  const mins = Math.max(0, Math.round((now - hold.since) / 60_000));
  const left = Math.max(0, Math.round((hold.until - now) / 60_000));
  return `${hold.who} · ${mins}m · ${left}m left`;
}
