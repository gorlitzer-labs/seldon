// The steward: the one agent you talk to. It reads what your other agents ask, puts it to you
// as one short message, and passes your answers and orders back to them through seldon.
// It is a plain Claude agent in its own tmux session; this file is its brief and its limits.

import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export const STEWARD = "steward";
export const STEWARD_SESSION = "seldon_steward";

// The only commands it may run without asking. Reading and messaging agents, starting and
// stopping them: never your files, never anything else.
export const STEWARD_ALLOWED = [
  "Bash(seldon lanes:*)", "Bash(seldon ls:*)", "Bash(seldon lane read:*)", "Bash(seldon lane say:*)",
  "Bash(seldon lane start:*)", "Bash(seldon lane stop:*)", "Bash(seldon machines:*)", "Bash(seldon new:*)",
];
export const STEWARD_DENIED = ["NotebookEdit"];
// The file tools it gets, and only inside its scratch folder (~/.seldon/steward/scratch).
export const STEWARD_FILE_TOOLS = ["Write", "Edit", "MultiEdit"];

// Its own scratch folder is the one place it writes. With Edit/Write denied outright it fell back
// to shell redirects, which Claude's auto-mode check rightly blocks. Allow rules let it write
// there without a prompt; the guard hook (stewardGuard, below) denies every other path, so
// nothing outside scratch is any wider than before — not even a prompt.
export function stewardCommand({ claude = "claude", model = "sonnet", brief, scratch, guard }) {
  // One Edit(path) rule covers every file tool (Claude ignores Write(path) / MultiEdit(path)).
  const allowed = [...STEWARD_ALLOWED, ...(scratch && guard ? [`Edit(/${scratch}/**)`] : [])];
  const denied = scratch && guard ? STEWARD_DENIED : [...STEWARD_FILE_TOOLS, ...STEWARD_DENIED];
  const settings = scratch && guard
    ? ["--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: [...STEWARD_FILE_TOOLS, "NotebookEdit"].join("|"), hooks: [{ type: "command", command: guard }] }] } })]
    : [];
  // Permission mode is set to ask even when your own sessions bypass permissions: anything
  // outside the list above waits for you in the steward's pane.
  return [claude, "-n", STEWARD, "--model", model, "--permission-mode", "default",
    "--allowedTools", allowed.join(","), "--disallowedTools", denied.join(","), ...settings,
    "--append-system-prompt", brief];
}

// Where a file tool would write, made absolute and with symlinks followed as far as they exist,
// so `scratch/../x` or a link out of scratch cannot pass.
const realish = (p) => {
  let head = resolve(p), tail = "";
  for (;;) {
    try { return resolve(realpathSync(head), tail); } catch { /* not there yet: go up */ }
    const up = resolve(head, "..");
    if (up === head) return resolve(p);
    tail = tail ? `${head.slice(up.length + 1)}${sep}${tail}` : head.slice(up.length + 1);
    head = up;
  }
};
// The PreToolUse verdict for one call: null to let the normal rules decide, or the reason it is denied.
export function stewardGuard(call, scratch) {
  if (![...STEWARD_FILE_TOOLS, "NotebookEdit"].includes(call?.tool_name)) return null;
  const target = call.tool_input?.file_path ?? call.tool_input?.notebook_path;
  if (typeof target !== "string" || !target) return "no file path";
  const root = realish(scratch), t = realish(target);
  if (t === root || t.startsWith(root + sep)) return null;
  return `the steward writes only in ${scratch}. Trust, settings and project files are Franco's (seldon lane start records Claude's folder trust itself).`;
}

export const STEWARD_BRIEF = `You are the steward: the one agent Franco talks to. Every other agent he runs is your team.
Your job is triage and relay, not doing their work.

Tools (seldon, run with Bash, exactly as written: \`seldon …\`, never prefixed with export, cd or env):
  seldon lanes --json               every agent, its state ("needs-you" = waiting on Franco)
  seldon lane read <name> --json    what an agent last said
  seldon lane say <name> "text"     type a message into an agent (only works while it waits);
                                    every one is logged and Franco sees the log under your messages
  seldon lane start <dir> --task "…" [--agent claude|codex|opencode]    start an agent
  seldon lane stop <name>           stop one
  seldon new <name> --task "…" [--agent codex]   a new project folder (git), with an agent on the task

When Franco asks "what needs me" or you are asked to check:
  1. List the agents. For each one waiting, read its last message.
  2. Write ONE short message: a numbered list, one line each: the agent, its question in plain
     words, and the one fact he needs to decide. Merge duplicates. Skip what needs nothing.
When Franco answers ("1 yes, 2 wait till tonight, 3 the first one"):
  3. Send each agent exactly his answer for it, in his words, made clear for that agent.
  4. Confirm in one line: "told joey: deploy to QA · told tars: use staging.x.com".

HARD RULE, above all others: Franco also talks to agents directly, so what you heard earlier
goes stale without you seeing it. Before ANY answer about what needs Franco or what an agent is
doing, run seldon lanes --json fresh, right then, and trust only that.
Never answer from earlier messages, your memory, or an earlier lanes read. An agent you thought
was waiting that is no longer "needs-you" is handled: say "joey: handled, working again" (or
done/stopped), never ask Franco about it again. Before sending Franco's answer to an agent, check it is still needs-you.

When a line starting "seldon:" arrives, it is seldon telling you which agents just started
waiting: read them (seldon lane read <name> --json) and write Franco one message, as above.
The same line may say an agent is "no longer waiting": drop it from what you track. Only if
your last message to Franco asked about it, add one line saying it is handled.

A line starting "Franco (Telegram):" is Franco writing from his phone. Answer him normally:
your answer reaches his phone on its own. Keep it short, it is read on a phone.

How to write (it is read on a phone):
  - One line per agent: "1. joey: deploy the warning to QA now?" Name, colon, the question.
  - No paragraphs of background: the one fact he needs goes in the same line.
  - Nothing to ask? Say so in one line: "Nothing needs you. joey and tars are working."

Rules, always:
  - Never decide for Franco. Never answer an agent on your own. If his answer is unclear, ask him.
  - Never type into an agent that is working.
  - Notes and drafts go in ~/.seldon/steward/scratch (Write/Edit work there, and only there).
    Never edit ~/.claude.json or any settings to trust a folder: seldon lane start and seldon new
    record Claude's trust themselves, and if one says Franco must trust a folder, tell him so.
  - Short. No preamble, no summaries of what you are about to do. Plain words, no jargon.
  - Orders he gives you ("stop joey", "start an agent on the save crash") you carry out, then
    say what you did in one line.`;

// ---- the feed: agents that start waiting reach the steward on their own -------------------
// The watcher calls this every few seconds with the lanes it just read. New waits are queued;
// once the oldest has waited BATCH_MS (so a few arrive together) and the steward is at rest,
// one line goes to it naming them. Waits that ended meanwhile are dropped, and the steward is
// never told about itself.
// A wait already told stays told until what it is about changes (its waitingFor or the time of
// its last message): a working/needs-you flicker is the same wait, not news. `lanes === null`
// means the read failed: nothing changes. A lane missing from a poll keeps its told memory
// until it has been gone TOLD_GONE_MS.
export const BATCH_MS = 60_000;
export const TOLD_GONE_MS = 10 * 60_000;
const about = (l) => `${l.waitingFor ?? ""}@${l.lastMessageAt ?? ""}`;
//
// The other half: a wait the steward was told about that ends (Franco answered the agent
// directly, it was stopped, its session vanished) is reported too, or the steward keeps asking
// about it. It counts as ended once the lane has been off needs-you for BATCH_MS (a flicker back
// resets that), or missing for TOLD_GONE_MS. Reported once, in the same line as new waits; the
// entry stays as `cleared`, so the same wait coming back is told again.
const ENDED = { working: "working again", running: "working again", idle: "done", failed: "failed", stopped: "stopped", gone: "stopped" };
export function stewardFeed(queue, lanes, now = Date.now()) {
  if (!Array.isArray(lanes)) return { queue, say: null };
  const byKey = new Map(lanes.map((l) => [l.key, l]));
  const steward = lanes.find((l) => l.name === STEWARD && !l.machine);
  const waiting = lanes.filter((l) => l.state === "needs-you" && l.name !== STEWARD);
  // told memory: older versions stored bare keys; read those as "told, about whatever it is now"
  const told = (queue.told || []).map((t) => (typeof t === "string" ? { key: t, about: byKey.get(t) ? about(byKey.get(t)) : null } : t))
    .map((t) => {
      const l = byKey.get(t.key);
      const base = { key: t.key, about: t.about, name: t.name ?? l?.name ?? l?.id ?? t.key, ...(t.cleared ? { cleared: true } : {}) };
      if (!l) return { ...base, goneAt: t.goneAt ?? now, ...(t.offSince ? { offSince: t.offSince } : {}) };
      if (l.state === "needs-you") return base;                       // still (or again) waiting: not ended
      return { ...base, offSince: t.offSince ?? now };
    })
    .filter((t) => !t.goneAt || now - t.goneAt <= TOLD_GONE_MS || !t.cleared);
  const isTold = (l) => told.some((t) => !t.cleared && t.key === l.key && (t.about === null || t.about === about(l)));
  const ended = told.filter((t) => !t.cleared && ((t.goneAt && now - t.goneAt > TOLD_GONE_MS) || (!t.goneAt && t.offSince && now - t.offSince >= BATCH_MS)));
  // keep what still waits on the same thing, add what newly waits
  let next = queue.filter((q) => byKey.get(q.key)?.state === "needs-you");
  for (const l of waiting) if (!next.some((q) => q.key === l.key) && !isTold(l)) next.push({ key: l.key, name: l.name || l.id, at: now, about: about(l) });
  next.told = told;
  const atRest = steward && (steward.state === "idle" || steward.state === "needs-you");
  const waitsDue = next.length && now - Math.min(...next.map((q) => q.at)) >= BATCH_MS;
  if (!atRest || (!waitsDue && !ended.length)) return { queue: next, say: null };
  const parts = [];
  if (waitsDue) parts.push(`waiting on Franco now: ${next.map((q) => q.name).join(", ")}. Read them and tell him in one message.`);
  if (ended.length) {
    const why = (t) => (t.goneAt ? "stopped" : ENDED[byKey.get(t.key)?.state] || "not waiting");
    parts.push(ended.length === 1
      ? `${parts.length ? "No longer waiting: " : ""}${ended[0].name}${parts.length ? "" : " is no longer waiting"} (${why(ended[0])}): drop it, do not ask Franco about it.`
      : `No longer waiting: ${ended.map((t) => `${t.name} (${why(t)})`).join(", ")}: drop them, do not ask Franco about them.`);
  }
  const out = waitsDue ? [] : next;
  const endedKeys = new Set(ended.map((t) => t.key));
  out.told = [
    ...told.filter((t) => !(waitsDue && next.some((q) => q.key === t.key)))
      .map((t) => (endedKeys.has(t.key) ? { ...t, cleared: true } : t))
      .filter((t) => !(t.cleared && t.goneAt && now - t.goneAt > TOLD_GONE_MS)),
    ...(waitsDue ? next.map((q) => ({ key: q.key, name: q.name, about: about(byKey.get(q.key)) })) : []),
  ];
  return { queue: out, say: `seldon: ${parts.join(" ")}` };
}

// ---- other ways the steward could hear old news -----------------------------------------
// A Telegram message older than this is not typed into the steward (the bot replays its last
// unconfirmed batch after a restart); it is kept in notes.md instead.
export const STALE_IN_MS = 10 * 60_000;
export const freshForSteward = (when, now = Date.now()) => now - when <= STALE_IN_MS;
// Agents' notes waiting for the steward, newer than the cursor (kept on disk across restarts).
export function notesSince(jsonl, cursor = 0) {
  const out = [];
  for (const l of String(jsonl || "").split("\n")) { try { const n = JSON.parse(l); if (n && n.at > cursor) out.push(n); } catch {} }
  return out;
}

// ---- the relay log: what the steward told whom ----------------------------------------
// The steward's session carries SELDON_STEWARD=1; every `seldon lane say` run there appends
// one line to ~/.seldon/steward/relay.jsonl. seldon writes it, not the steward, so a message
// it sends cannot go unrecorded.
export const stewardEnv = (pathVar) => ["-e", `PATH=${pathVar}`, "-e", "SELDON_STEWARD=1"];
export const relayLine = (to, text, at = Date.now()) => JSON.stringify({ to, text, at }) + "\n";
export function recentRelays(jsonl, n = 5) {
  const out = [];
  for (const l of String(jsonl || "").split("\n")) { try { const e = JSON.parse(l); if (e?.to && typeof e.text === "string") out.push(e); } catch {} }
  return out.slice(-n).reverse();          // newest first
}

// ---- Telegram: the steward is the voice on your phone ---------------------------------------
// Out: when the steward finishes a new message (at rest, file quiet a few seconds), it goes to
// Telegram as one card. The first look only remembers where things are, so starting up never
// re-sends an old message.
export const QUIET_MS = 8000;
export function stewardOutbox(seen, steward, now = Date.now()) {
  if (!steward || !steward.text || !steward.at) return { seen, send: null };
  if (!seen) return { seen: { at: steward.at }, send: null };
  const atRest = steward.state === "idle" || steward.state === "needs-you";
  if (!atRest || steward.at <= seen.at || now - steward.at < QUIET_MS) return { seen, send: null };
  return { seen: { at: steward.at }, send: steward.text };
}
// In: what you write in the chat waits until the steward is free, then goes in as one line.
export const FROM_PHONE = "Franco (Telegram):";
export function stewardInbox(queue, stewardState) {
  const atRest = stewardState === "idle" || stewardState === "needs-you";
  if (!queue.length || !atRest) return { queue, say: null };
  return { queue: [], say: `${FROM_PHONE} ${queue.join(" · ")}` };
}

// Agents' own text messages (seldon tell, no file) go to the steward while it runs, not to your
// phone: it passes on what matters in its next message. Media still go straight to you.
export const TELLS_PREFIX = "seldon: your agents sent Franco these notes; pass on only what he needs, in your next message:";
export function deliverWhenFree(queue, stewardState, prefix) {
  const atRest = stewardState === "idle" || stewardState === "needs-you";
  if (!queue.length || !atRest) return { queue, say: null };
  return { queue: [], say: `${prefix} ${queue.join(" · ")}` };
}
