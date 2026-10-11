/**
 * Whether apiary-launched agents run unattended.
 *
 * An agent apiary spawned to sit in a room has nobody watching its pane. Every
 * approval prompt is therefore a permanent stall: the agent stops, the room
 * cannot answer it, and from the outside it looks like the agent is thinking.
 * Observed repeatedly in practice — a single session hit a command approval, a
 * dev-server approval and a `git add` approval within an hour, each one halting
 * work until a human happened to look at the right tmux pane.
 *
 * So the default is unattended, per CLI:
 *
 *   - Claude Code: `--dangerously-skip-permissions`
 *   - Codex: `approval_policy = "never"` in apiary's config profile, plus
 *     per-tool `approval_mode` for apiary's own MCP tools (the two are
 *     separate gates — `approval_policy` does not cover MCP tool calls)
 *
 * Codex still executes inside its sandbox, so anything it will not allow
 * returns a failure to the model rather than asking. Claude's flag is broader
 * and genuinely skips all permission checks — the room is only as trusted as
 * the repos its agents point at.
 */

/** Env var that turns the default off. */
export const APPROVALS_ENV = "APIARY_AGENT_APPROVALS";

/**
 * True unless `APIARY_AGENT_APPROVALS=ask`.
 *
 * "ask" restores the interactive behaviour, at the cost of having to babysit
 * each agent's terminal.
 */
export function wantsUnattendedAgents(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[APPROVALS_ENV]?.trim().toLowerCase() !== "ask";
}
