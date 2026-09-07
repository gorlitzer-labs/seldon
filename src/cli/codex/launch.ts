/**
 * Codex launch wiring — how apiary declares itself to a Codex session.
 *
 * apiary needs two things from a Codex session: its MCP server declared, and
 * its own tools auto-approved (an agent spawned to sit in a room cannot join
 * one if every join_room call blocks on a keypress nobody is there to press).
 *
 * Both are declared in a Codex *config profile* — `<CODEX_HOME>/<name>.config.toml`,
 * layered over the user's base config by `codex --profile <name>`. apiary owns
 * the `apiary-<agent>` profile name and deletes the file when the agent stops.
 *
 * Two alternatives were tried and rejected:
 *
 *   - A throwaway CODEX_HOME (what apiary used to do). CODEX_HOME is where
 *     `auth.json` lives, so a logged-in user still landed on the OAuth sign-in
 *     screen and the agent never reached a prompt; it also silently dropped
 *     `model`, reasoning effort and project trust. Copying auth.json in only
 *     moves the problem, because Codex rotates the refresh token and writes it
 *     back to CODEX_HOME — the refreshed credentials would die with the temp
 *     directory while the user's real ~/.codex kept a token already spent.
 *
 *   - `codex -c key=value` overrides. Correct in principle, but auto-approval
 *     is per tool, so it needs ~17 flags — a 1.2KB command line, which is
 *     typed into the pane a keystroke at a time and gets truncated mid-quote.
 *
 * A profile keeps the user's real Codex home (credentials, model, project
 * trust all intact) and the launch command stays one short line.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { RUNTIME_TOOL_NAMES } from "../../agent/mcp/runtime.js";

/** Timeouts for apiary's own MCP server, in seconds. */
const STARTUP_TIMEOUT_SEC = 15;
const TOOL_TIMEOUT_SEC = 60;

const PROFILE_PREFIX = "apiary-";

/** The user's real Codex home — honours CODEX_HOME so nested launches behave. */
export function userCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

/**
 * How Codex should treat calls to apiary's own MCP tools.
 *
 * `"approve"` means "run without asking". Anyone who would rather confirm each
 * call can set APIARY_CODEX_TOOL_APPROVAL (Codex's own value, e.g. "ask") —
 * with the caveat that a background-spawned agent then cannot join a room
 * unattended, because nobody is watching its pane to press a key.
 */
export function codexToolApprovalMode(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APIARY_CODEX_TOOL_APPROVAL?.trim();
  return override && override.length > 0 ? override : "approve";
}

/**
 * Profile name for an agent. Codex resolves this to a filename, so keep it to
 * characters that cannot escape the Codex home or confuse the CLI.
 */
export function codexProfileName(agentName: string): string {
  const safe = agentName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  // A name that sanitises down to nothing but separators is degenerate, and
  // would have every such agent colliding on the same profile.
  return `${PROFILE_PREFIX}${/[A-Za-z0-9]/.test(safe) ? safe : "agent"}`;
}

/** Render a TOML string value: `"http://host/path"`. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The profile body: apiary's MCP server, and per-tool auto-approval.
 *
 * Per tool, not per server: Codex accepts `approval_mode` on the server table
 * and then ignores it. Only `mcp_servers.<server>.tools.<tool>` is honoured —
 * the shape Codex itself writes when a human picks "Always allow".
 *
 * Scoped deliberately: shell commands, file writes and every other MCP server
 * still go through Codex's normal approval flow.
 */
export function renderCodexProfile(
  mcpUrl: string,
  approvalMode: string = codexToolApprovalMode(),
): string {
  const blocks = [
    [
      "# Written by apiary. Layered over your own config; deleted when the agent stops.",
      "[mcp_servers.apiary]",
      `url = ${tomlString(mcpUrl)}`,
      `startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}`,
      `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
    ].join("\n"),
    ...RUNTIME_TOOL_NAMES.map((tool) => [
      `[mcp_servers.apiary.tools.${tool}]`,
      `approval_mode = ${tomlString(approvalMode)}`,
    ].join("\n")),
  ];

  return blocks.join("\n\n") + "\n";
}

/** Absolute path of an agent's profile file. */
export function codexProfilePath(agentName: string, codexHome: string = userCodexHome()): string {
  return join(codexHome, `${codexProfileName(agentName)}.config.toml`);
}

/**
 * Write the agent's profile and return the launch command.
 *
 * `extraArgs` are the user's own passthrough flags and come last, so
 * `apiary codex bee --model gpt-5.6-terra` still wins over the profile.
 */
export function prepareCodexLaunch(
  agentName: string,
  mcpUrl: string,
  extraArgs: string[] = [],
  codexHome: string = userCodexHome(),
): { command: string; profilePath: string } {
  mkdirSync(codexHome, { recursive: true });

  const profilePath = codexProfilePath(agentName, codexHome);
  writeFileSync(profilePath, renderCodexProfile(mcpUrl), { mode: 0o600 });

  const command = ["codex", "--profile", codexProfileName(agentName), ...extraArgs].join(" ");
  return { command, profilePath };
}

/** Remove an agent's profile. Never throws. */
export function clearCodexProfile(agentName: string, codexHome: string = userCodexHome()): void {
  try {
    rmSync(codexProfilePath(agentName, codexHome), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Delete apiary profiles left behind by agents that are no longer running —
 * a crashed or SIGKILLed runtime never reaches its cleanup path, and these
 * would otherwise accumulate in the user's Codex home forever.
 */
export function pruneCodexProfiles(
  liveAgentNames: readonly string[],
  codexHome: string = userCodexHome(),
): number {
  if (!existsSync(codexHome)) return 0;

  const live = new Set(liveAgentNames.map((name) => `${codexProfileName(name)}.config.toml`));
  let removed = 0;

  try {
    for (const entry of readdirSync(codexHome)) {
      if (!entry.startsWith(PROFILE_PREFIX) || !entry.endsWith(".config.toml")) continue;
      if (live.has(entry)) continue;
      try {
        rmSync(join(codexHome, entry), { force: true });
        removed++;
      } catch {
        /* leave it for next time */
      }
    }
  } catch {
    /* unreadable home — nothing to prune */
  }

  return removed;
}
