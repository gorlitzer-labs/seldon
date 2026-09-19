// foundation doctor — aggregate every deterministic check; exit non-zero on drift. CI-friendly.
import { join } from "node:path";
import { read } from "./lib/fs.mjs";
import { Findings, say, c } from "./lib/log.mjs";
import * as seam from "./lib/seam.mjs";
import { phaseProgress } from "./lib/progress.mjs";
import { scanReversals } from "./tripwire.mjs";

const docs = (root, f) => read(join(root, "docs", f)) || "";

export async function doctor(root) {
  say(c.bold("foundation doctor"));
  const f = new Findings();

  // 1. Seam parse warnings (unknown/malformed rows = LOUD, never silently empty)
  const ws = seam.parseWorkstreams(docs(root, "WORKSTREAMS.md"));
  for (const w of ws.warnings) f.drift(`WORKSTREAMS.md:${w.line + 1} ${w.why}`);
  const q = seam.parseQueue(docs(root, "QUEUE.md"));
  for (const w of q.warnings) f.note(`QUEUE.md:${w.line + 1} ${w.why}`);
  const d = seam.parseDone(docs(root, "DONE.md"));
  for (const w of d.warnings) f.drift(`DONE.md:${w.line + 1} ${w.why}`);

  // 2. FACTS: structural issues + 14-day staleness
  const facts = seam.parseFacts(docs(root, "FACTS.md"));
  for (const i of facts.issues) f.drift(`FACTS.md:${(i.line ?? 0) + 1} ${i.why}`);
  for (const fact of facts.facts) {
    if (fact.verified && seam.isIsoStamp(fact.verified)) {
      const age = seam.daysSince(fact.verified);
      if (age > seam.FACT_STALE_DAYS) f.drift(`FACTS.md: \`${fact.id}\` verified ${age}d ago (>${seam.FACT_STALE_DAYS}) — re-verify or delete`);
    }
  }

  // 3. Forbidden-glyph lint across the seam (the fragility we refuse to inherit)
  for (const file of ["QUEUE.md", "WORKSTREAMS.md", "DONE.md", "FACTS.md"]) {
    const text = docs(root, file);
    text.split("\n").forEach((ln, i) => {
      // ignore prose intros; only flag glyphs on data-ish lines (list items / table rows)
      if (/^(- |\|)/.test(ln) && seam.hasForbiddenGlyph(ln)) f.drift(`${file}:${i + 1} forbidden glyph (—/·/•) on a data line — use ASCII`);
    });
  }

  // 4. Phase 100% but a done-marker not reflected (cheap consistency note)
  const { per } = phaseProgress(root);
  for (const p of per) if (p.total > 0 && p.pct === 100) f.note(`${p.file.replace(root + "/", "")} is 100% — confirm it's closed in WORKSTREAMS/DONE`);

  // 5. ADR reversal tripwire
  for (const h of scanReversals(root)) f.drift(`ADR reversed? "${h.adr}" rejected ${h.rejected}, but deps contain: ${h.foundInDeps.join(", ")}`);

  return f.render();
}
