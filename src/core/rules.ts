/**
 * Room rules — a small text-based set of ground rules visible to every
 * participant, surfaced to agents on join via the `apiary__join_room` MCP
 * response and to humans via the `/rules` TUI command.
 *
 * Storage: per-room Markdown file at `~/.apiary/rooms/<name>.rules.md`, with
 * an optional global default at `~/.apiary/rules.default.md` that new rooms
 * inherit. Format mirrors what `.cursorrules` / `.editorconfig` / Claude
 * Code's `CLAUDE.md` converged on — Markdown with a bullet list, hand-editable
 * by any editor.
 *
 * Schema growth (v1 → v2): v1 stores rules as `string[]` (one bullet per
 * rule). v2 can add optional YAML frontmatter with `schema: apiary.rules/2`
 * and structured per-rule metadata; the v1 parser keeps working on v2
 * documents because frontmatter starts with `---` and is skipped before bullet
 * extraction. Only `schema` and the bullet `text` carry meaning across
 * versions; everything else is opaque-but-preserved (the `.editorconfig`
 * lesson). The design deliberately drops MUST / SHOULD severity — OpenAI's
 * Model Spec found it invites lawyering with no compliance gain.
 *
 * Enforcement: v1 is voluntary compliance only. No audit, no kick-on-violation.
 * Honest about that — rules are guidance for an LLM, not a sandbox.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin, dirname } from "node:path";

/**
 * The apiary house ruleset — opinionated defaults. Imperative verbs, no
 * MUST/SHOULD, bee-themed for the apiary tone.
 *
 * Hard-capped: agents tune out long rule lists, and apiary will be tempted
 * to grow this over time. Past ~10 rules compliance per rule drops sharply.
 */
export const DEFAULT_RULES: readonly string[] = [
  "Never push to main. Open a PR.",
  "Don't touch repos you don't own — your cwd is your hive.",
  "No force-push, no `git reset --hard`, no `rm -rf` on anything you didn't make this session.",
  "Announce destructive intent before you act. \"About to delete X\" beats \"I deleted X, sorry.\"",
  "If a human is in the room, wait for their ack before merging, deploying, or running anything irreversible.",
  "Stay in your lane. If a task belongs to another agent, @mention them — don't poach.",
  "When uncertain, ask. A clarifying question costs a token; a wrong commit costs an afternoon.",
];

export const RULES_MAX = 12; // hard cap — keeps the list scannable for humans + LLMs

const APIARY_DIR = pathJoin(homedir(), ".apiary");
const GLOBAL_DEFAULT_PATH = pathJoin(APIARY_DIR, "rules.default.md");
const ROOMS_DIR = pathJoin(APIARY_DIR, "rooms");

export function roomRulesPath(roomName: string): string {
  return pathJoin(ROOMS_DIR, `${roomName}.rules.md`);
}

// ── Markdown serialization ────────────────────────────────────────────────

/**
 * Parse a Markdown rules document. Strips optional `---` YAML frontmatter
 * (forward-compat with v2), then extracts every line that starts with `- `
 * or `* ` as one rule, trimming the marker.
 *
 * Unknown frontmatter keys are ignored — this is what makes the format
 * evolvable. See `.editorconfig` spec for the same design.
 */
export function parseRulesMarkdown(content: string): string[] {
  let body = content.trimStart();
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4); // skip past closing `---\n`
  }
  const rules: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("- ")) rules.push(line.slice(2).trim());
    else if (line.startsWith("* ")) rules.push(line.slice(2).trim());
  }
  return rules.filter((r) => r.length > 0);
}

export function formatRulesMarkdown(rules: readonly string[]): string {
  const header = "# Room rules\n\n";
  const body = rules.map((r) => `- ${r}`).join("\n");
  return header + body + "\n";
}

// ── Disk I/O — with global → room cascade ─────────────────────────────────

/**
 * Load rules for a room with cascade:
 *   1. If `~/.apiary/rooms/<name>.rules.md` exists → use it (room override).
 *   2. Else if `~/.apiary/rules.default.md` exists → use it.
 *   3. Else fall back to DEFAULT_RULES.
 *
 * The returned array is never longer than RULES_MAX; extras are dropped.
 */
export function loadRulesForRoom(roomName: string): string[] {
  const roomPath = roomRulesPath(roomName);
  const candidates = [roomPath, GLOBAL_DEFAULT_PATH];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const parsed = parseRulesMarkdown(readFileSync(p, "utf-8"));
        if (parsed.length > 0) return parsed.slice(0, RULES_MAX);
      } catch {
        /* corrupt file — fall through */
      }
    }
  }
  return [...DEFAULT_RULES];
}

/** Write the per-room rules file, creating the rooms dir if needed. */
export function saveRulesForRoom(roomName: string, rules: readonly string[]): void {
  const p = roomRulesPath(roomName);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatRulesMarkdown(rules.slice(0, RULES_MAX)));
}

/**
 * Seed the per-room rules file with defaults if it doesn't exist yet. Returns
 * the path written, or null if already present.
 */
export function seedRulesIfMissing(roomName: string): string | null {
  const p = roomRulesPath(roomName);
  if (existsSync(p)) return null;
  // Seed from the cascade (global default if present, else built-in defaults).
  const initial = existsSync(GLOBAL_DEFAULT_PATH)
    ? parseRulesMarkdown(readFileSync(GLOBAL_DEFAULT_PATH, "utf-8"))
    : [...DEFAULT_RULES];
  saveRulesForRoom(roomName, initial.length > 0 ? initial : [...DEFAULT_RULES]);
  return p;
}

