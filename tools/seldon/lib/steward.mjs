// The steward: the one agent you talk to. It reads what your other agents ask, puts it to you
// as one short message, and passes your answers and orders back to them through seldon.
// It is a plain Claude agent in its own tmux session; this file is its brief and its limits.

export const STEWARD = "steward";
export const STEWARD_SESSION = "seldon_steward";

// The only commands it may run without asking. Reading and messaging agents, starting and
// stopping them: never your files, never anything else.
export const STEWARD_ALLOWED = [
  "Bash(seldon lanes:*)", "Bash(seldon ls:*)", "Bash(seldon lane read:*)", "Bash(seldon lane say:*)",
  "Bash(seldon lane start:*)", "Bash(seldon lane stop:*)", "Bash(seldon machines:*)",
];
export const STEWARD_DENIED = ["Edit", "Write", "NotebookEdit"];

export function stewardCommand({ claude = "claude", model = "sonnet", brief }) {
  // Permission mode is set to ask even when your own sessions bypass permissions: anything
  // outside the list above waits for you in the steward's pane.
  return [claude, "-n", STEWARD, "--model", model, "--permission-mode", "default",
    "--allowedTools", STEWARD_ALLOWED.join(","), "--disallowedTools", STEWARD_DENIED.join(","),
    "--append-system-prompt", brief];
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

When Franco asks "what needs me" or you are asked to check:
  1. List the agents. For each one waiting, read its last message.
  2. Write ONE short message: a numbered list, one line each: the agent, its question in plain
     words, and the one fact he needs to decide. Merge duplicates. Skip what needs nothing.
When Franco answers ("1 yes, 2 wait till tonight, 3 the first one"):
  3. Send each agent exactly his answer for it, in his words, made clear for that agent.
  4. Confirm in one line: "told joey: deploy to QA · told tars: use staging.x.com".

When a line starting "seldon:" arrives, it is seldon telling you which agents just started
waiting: read them (seldon lane read <name> --json) and write Franco one message, as above.

Rules, always:
  - Never decide for Franco. Never answer an agent on your own. If his answer is unclear, ask him.
  - Never type into an agent that is working.
  - Short. No preamble, no summaries of what you are about to do. Plain words, no jargon.
  - Orders he gives you ("stop joey", "start an agent on the save crash") you carry out, then
    say what you did in one line.`;

// ---- the feed: agents that start waiting reach the steward on their own -------------------
// The watcher calls this every few seconds with the lanes it just read. New waits are queued;
// once the oldest has waited BATCH_MS (so a few arrive together) and the steward is at rest,
// one line goes to it naming them. Waits that ended meanwhile are dropped, and the steward is
// never told about itself.
export const BATCH_MS = 60_000;
export function stewardFeed(queue, lanes, now = Date.now()) {
  const byKey = new Map(lanes.map((l) => [l.key, l]));
  const steward = lanes.find((l) => l.name === STEWARD && !l.machine);
  const waiting = lanes.filter((l) => l.state === "needs-you" && l.name !== STEWARD);
  // keep what still waits, add what newly waits
  let next = queue.filter((q) => byKey.get(q.key)?.state === "needs-you");
  for (const l of waiting) if (!next.some((q) => q.key === l.key) && !(queue.told || []).includes(l.key)) next.push({ key: l.key, name: l.name || l.id, at: now });
  const told = (queue.told || []).filter((k) => byKey.get(k)?.state === "needs-you");   // forget a wait once it ends
  next.told = told;
  const atRest = steward && (steward.state === "idle" || steward.state === "needs-you");
  if (!next.length || !atRest || now - Math.min(...next.map((q) => q.at)) < BATCH_MS) return { queue: next, say: null };
  const names = next.map((q) => q.name);
  const out = []; out.told = [...told, ...next.map((q) => q.key)];
  return { queue: out, say: `seldon: waiting on Franco now: ${names.join(", ")}. Read them and tell him in one message.` };
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
