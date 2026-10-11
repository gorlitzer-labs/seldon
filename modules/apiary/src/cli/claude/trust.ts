/**
 * Pre-accept Claude Code's trust dialog for an agent's working directory.
 *
 * The first time Claude Code runs in a directory it shows a modal:
 *
 *   Quick safety check: Is this a project you created or one you trust?
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 * Neither `--dangerously-skip-permissions` nor
 * `--permission-mode bypassPermissions` skips it — verified against Claude
 * Code directly, both land on the same modal. It is a deliberate security
 * boundary, and the only supported way past it is the acceptance Claude itself
 * records in `~/.claude.json` under `projects[<dir>].hasTrustDialogAccepted`.
 *
 * That matters for apiary specifically: nobody watches an agent's tmux pane, so
 * an agent spawned into a repo Claude has not seen before waits on that modal
 * forever. The room reports it (the bridge reads "Esc to cancel" as a dialog,
 * which surfaces as "needs you"), but reporting a stall is worse than not
 * having one.
 *
 * Recording it is a faithful reading of intent rather than an escalation: the
 * user pointed an agent at this directory, which is the same assertion the
 * dialog asks for. Nothing else in the file is touched, and the write is
 * atomic so a crash cannot truncate a config holding dozens of projects.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Claude Code's config file. */
export function claudeConfigPath(home: string = homedir()): string {
  return join(home, ".claude.json");
}

export type TrustOutcome =
  | "already-trusted"   // Claude had already recorded acceptance
  | "trusted"           // we recorded it
  | "no-config"         // Claude has never run here; it will ask once
  | "skipped"           // opted out
  | "failed";           // unreadable/unwritable/malformed — left alone

/**
 * Record trust for `cwd` in Claude Code's config.
 *
 * Never throws. Returns what happened so the caller can tell the user, because
 * a silent no-op here shows up much later as an agent that never joined.
 */
export function preAcceptClaudeTrust(
  cwd: string,
  opts?: { configPath?: string; enabled?: boolean },
): TrustOutcome {
  if (opts?.enabled === false) return "skipped";

  const path = opts?.configPath ?? claudeConfigPath();
  // Claude keys projects by absolute path, exactly as it resolves the cwd.
  const key = resolve(cwd);

  if (!existsSync(path)) return "no-config";

  let parsed: Record<string, unknown>;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed or unreadable — do not attempt a rewrite. Losing a config with
    // dozens of projects is far worse than one trust prompt.
    return "failed";
  }
  if (typeof parsed !== "object" || parsed === null) return "failed";

  const projects = (parsed.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (typeof projects !== "object" || projects === null) return "failed";

  const existing = projects[key];
  if (existing && existing.hasTrustDialogAccepted === true) return "already-trusted";

  // Merge into whatever is already recorded for this project — it may hold
  // allowedTools, MCP server lists and history we must not drop.
  projects[key] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
  parsed.projects = projects;

  const tmp = `${path}.apiary-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return "trusted";
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return "failed";
  }
}
