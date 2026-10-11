// Deterministic checkbox counting — the ONLY place phase progress is computed.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { read } from "./fs.mjs";

const COUNT = (text) => {
  const done = (text.match(/^- \[x\] /gm) || []).length;
  const open = (text.match(/^- \[ \] /gm) || []).length;
  const total = done + open;
  return { done, open, total, pct: total ? Math.round((done / total) * 100) : 0 };
};

// Walk docs/phases/**/ *TASKS*.md, return per-file + overall counts.
export function phaseProgress(root) {
  const dir = join(root, "docs", "phases");
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/tasks.*\.md$/i.test(e)) files.push(p);
    }
  };
  walk(dir);
  const per = files.map((f) => ({ file: f, ...COUNT(read(f) || "") }));
  const overall = per.reduce((a, p) => ({ done: a.done + p.done, open: a.open + p.open, total: a.total + p.total }), { done: 0, open: 0, total: 0 });
  overall.pct = overall.total ? Math.round((overall.done / overall.total) * 100) : 0;
  return { per, overall };
}

// Flip one checkbox in an explicit phase file, matched by a task id/text token. Returns updated text.
export function flipCheckbox(text, token) {
  const lines = text.split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \] /.test(lines[i]) && lines[i].includes(token)) { hit = i; break; }
  }
  if (hit === -1) return { ok: false };
  lines[hit] = lines[hit].replace("- [ ] ", "- [x] ");
  // Recompute an "Overall Progress" line if the file has one.
  const joined = lines.join("\n");
  const { pct, done, total } = COUNT(joined);
  const withBar = joined.replace(
    /(\*\*Overall Progress\*\*:).*$/m,
    `$1 ${done}/${total} (${pct}%)`
  );
  return { ok: true, text: withBar, pct, done, total, line: hit };
}
