// Entire: why each lane's agent made each change.
//
// Entire (https://entire.com, `entire` CLI, MIT) hooks into the agent and into git. When an agent
// commits, it links the commit to the agent session that produced it with an
// `Entire-Checkpoint: <id>` trailer, and keeps the prompt, the redacted transcript, the files
// touched and the token count under refs/entire/checkpoints/*, pushed alongside your branches.
// seldon does not store any of it: it turns it on for a project and reads it back per lane.
//
// Pure, like lanes.mjs: callers run the commands and pass the output in.

export const TRAILER = "Entire-Checkpoint";

// seldon's harness names → Entire's agent names.
export const ENTIRE_AGENT = { claude: "claude-code", codex: "codex", opencode: "opencode" };

// One line per commit: short sha, subject, checkpoint ids (comma-separated, usually one).
export const LOG_FORMAT = `%h%x1f%s%x1f%(trailers:key=${TRAILER},valueonly,separator=%x2C)`;

/** Commits on a lane that carry a checkpoint, newest first: [{ sha, subject, ids }]. */
export function parseCheckpointLog(text) {
  return String(text || "").split("\n").filter(Boolean).map((line) => {
    const [sha, subject = "", ids = ""] = line.split("\x1f");
    return { sha, subject, ids: ids.split(",").map((s) => s.trim()).filter(Boolean) };
  }).filter((c) => c.ids.length);
}

/**
 * The commands that turn Entire on for a project: Claude Code first (it is the one `enable`
 * configures), then one `agent add` per other harness installed here. Checkpoints go to
 * `remote` only; telemetry stays off.
 */
export function enableSteps({ remote = "origin", harnesses = [] } = {}) {
  const steps = [["entire", ["enable", "--agent", ENTIRE_AGENT.claude, "--telemetry=false", "--checkpoint-push-remote", remote]]];
  for (const h of harnesses) if (h !== "claude" && ENTIRE_AGENT[h]) steps.push(["entire", ["agent", "add", ENTIRE_AGENT[h]]]);
  return steps;
}

/**
 * The commits a lane added: everything on its HEAD that the project's default branch lacks.
 * `defaultRef` is what `git rev-parse --abbrev-ref origin/HEAD` printed (e.g. "origin/main"),
 * or empty when the clone has no remote HEAD.
 */
export function laneRange(defaultRef) {
  const ref = String(defaultRef || "").trim();
  return `${ref && ref !== "origin/HEAD" ? ref : "main"}..HEAD`;
}
