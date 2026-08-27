// foundation init — install the seam + doc scaffold + multi-harness skills into a repo
// (idempotent, bolt-onto-existing: never clobbers user docs; re-syncs Foundation-owned skills).
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { read, writeAtomic } from "./lib/fs.mjs";
import { mirrorSkill } from "./lib/mirror.mjs";
import { ok, say, c } from "./lib/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "payload", "doc-templates");
const SKILLS = join(HERE, "..", "payload", "skills");
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };

export async function init(root) {
  const dst = join(root, "docs");
  mkdirSync(join(dst, "phases"), { recursive: true });

  // 1. Doc scaffold — never clobber existing user content.
  let created = 0, kept = 0;
  for (const f of ls(DOCS)) {
    if (!f.endsWith(".md")) continue;
    const target = join(dst, f);
    if (existsSync(target)) { kept++; continue; }
    writeAtomic(target, read(join(DOCS, f)));
    created++;
  }

  // 2. Skills — Foundation-owned, re-synced in place (Claude verbatim + mirrored to other harnesses).
  let skills = 0, mirrors = 0;
  for (const name of ls(SKILLS)) {
    const src = join(SKILLS, name, "SKILL.md");
    if (!existsSync(src)) continue;
    const raw = read(src);
    writeAtomic(join(root, ".claude", "skills", name, "SKILL.md"), raw);   // Claude Code
    skills++;
    for (const m of mirrorSkill(name, raw)) { writeAtomic(join(root, m.rel), m.content); mirrors++; }  // Cursor/Copilot/Codex
  }

  ok(`Foundation installed → ${root}`);
  say(c.dim(`  docs:   ${created} created, ${kept} kept  (seam: QUEUE · WORKSTREAMS · DONE · FACTS)`));
  say(c.dim(`  skills: ${skills} → .claude/skills/  (+ ${mirrors} harness mirrors: cursor · copilot · codex)`));
  say(c.dim("  next:   /kickstart <idea>   ·   foundation status   ·   foundation doctor"));
}
