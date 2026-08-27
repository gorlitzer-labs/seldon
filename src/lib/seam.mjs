// Foundation seam grammar — QUEUE / WORKSTREAMS / DONE / FACTS.
//
// Design goals (where we beat the ancestor's grammar):
//  - ASCII, visible, un-confusable delimiters — NO load-bearing em-dash/middot.
//  - Loud on the unknown: an unrecognized row is preserved verbatim + line-numbered, never dropped
//    and never silently read as empty.
//  - Markdown is authoritative; ids are content-hashed and never written into the file.
//  - Write-time validation lives with the writers (in the command layer) so bad input fails at
//    authoring, not silently at parse.
import { createHash } from "node:crypto";

export const FORBIDDEN_GLYPHS = ["—", "–", "·", "•"]; // em/en-dash, middot, bullet
export const hasForbiddenGlyph = (s) => FORBIDDEN_GLYPHS.some((g) => s.includes(g));
export const isKebab = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s);
export const isPriority = (s) => /^P[123]$/.test(s);
export const isRef = (s) => /^\S+[#@]\S+$/.test(s);              // owner/repo#N or owner/repo@sha
export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isIsoStamp = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(s);

export const hashId = (kind, seed) => `${kind}-${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;

// ── Section helpers ───────────────────────────────────────────────────────────
// Return {found, start, bodyStart, end} line indices for a `## Heading` (case-insensitive).
// end is the line index of the next `## ` heading (or lines.length).
export function findSection(lines, heading) {
  const h = heading.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m && m[1].toLowerCase() === h) { start = i; break; }
  }
  if (start === -1) return { found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return { found: true, start, bodyStart: start + 1, end };
}

// ── QUEUE ──────────────────────────────────────────────────────────────────────
// `- [ ] (P1) text`  under `## Queue`.  `### Sub` headings tag the item's section.
export function parseQueue(text) {
  const lines = (text ?? "").split("\n");
  const sec = findSection(lines, "Queue");
  const items = [];
  const warnings = [];
  if (!sec.found) return { items, warnings };
  let section = null;
  for (let i = sec.bodyStart; i < sec.end; i++) {
    const raw = lines[i];
    const sub = raw.match(/^###\s+(.+?)\s*$/);
    if (sub) { section = sub[1]; continue; }
    const m = raw.match(/^- \[( |x)\] \((P[123])\) (.+)$/);
    if (m) { items.push({ done: m[1] === "x", priority: m[2], text: m[3], section, line: i, raw, id: hashId("q", m[3]) }); continue; }
    if (raw.trim() && !raw.trim().startsWith("<!--")) warnings.push({ line: i, raw, why: "not a queue item" });
  }
  return { items, warnings };
}

// ── DONE ─────────────────────────────────────────────────────────────────────
// `- [x] task [owner/repo#N] [YYYY-MM-DD]`  under `## Done` (append-only).
export function parseDone(text) {
  const lines = (text ?? "").split("\n");
  const sec = findSection(lines, "Done");
  const items = [];
  const warnings = [];
  if (!sec.found) return { items, warnings };
  for (let i = sec.bodyStart; i < sec.end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("<!--")) continue;
    const m = raw.match(/^- \[x\] (.+?)(?:\s+\[([^\]]+)\])?(?:\s+\[(\d{4}-\d{2}-\d{2})\])?\s*$/);
    if (m && m[2] && isRef(m[2])) {
      items.push({ task: m[1], ref: m[2], date: m[3] ?? null, line: i, raw, id: hashId("d", m[1] + m[2]) });
    } else {
      warnings.push({ line: i, raw, why: "done entry missing a [owner/repo#N] ref" });
    }
  }
  return { items, warnings };
}

// ── WORKSTREAMS ─────────────────────────────────────────────────────────────
// 6-col pipe table: | Stream | Owner | Branch/Worktree | Status | Blocker | Last note |
export const WS_HEADERS = ["stream", "owner", "branch/worktree", "status", "blocker", "last note"];
const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
export function parseWorkstreams(text) {
  const lines = (text ?? "").split("\n");
  const rows = [];
  const warnings = [];
  let headerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      const c = cells(lines[i]).map((x) => x.toLowerCase());
      if (WS_HEADERS.every((h, k) => c[k] === h) && c.length === 6) { headerLine = i; break; }
    }
  }
  if (headerLine === -1) return { rows, warnings };
  for (let i = headerLine + 2; i < lines.length; i++) { // +2 skips the |---| alignment row
    if (!/^\s*\|/.test(lines[i])) break;
    const c = cells(lines[i]);
    if (c.length !== 6) { warnings.push({ line: i, raw: lines[i], why: `malformed row: ${c.length} cells, expected 6` }); continue; }
    rows.push({ stream: c[0], owner: c[1], branchWorktree: c[2], status: c[3], blocker: c[4], lastNote: c[5], line: i, raw: lines[i] });
  }
  return { rows, warnings, headerLine };
}

// Structural upsert of one workstream row by stream id. Preserves the rest of the file byte-for-byte.
export function upsertStreamRow(text, row) {
  const lines = (text ?? "").split("\n");
  const { rows, headerLine } = parseWorkstreams(text);
  const rendered = `| ${row.stream} | ${row.owner} | ${row.branchWorktree} | ${row.status} | ${row.blocker || "-"} | ${row.lastNote || "-"} |`;
  const existing = rows.find((r) => r.stream === row.stream);
  if (existing) { lines[existing.line] = rendered; return lines.join("\n"); }
  if (headerLine === -1) throw new Error("WORKSTREAMS.md has no v1 table header");
  // insert after the last data row (or the alignment row if none)
  const last = rows.length ? rows[rows.length - 1].line : headerLine + 1;
  lines.splice(last + 1, 0, rendered);
  return lines.join("\n");
}

// ── FACTS ─────────────────────────────────────────────────────────────────────
// - `kebab-id`: claim
//     verified: <ISO>  by: <who>  method: <how>
export const FACT_STALE_DAYS = 14;
export function parseFacts(text) {
  const lines = (text ?? "").split("\n");
  const sec = findSection(lines, "Facts");
  const facts = [];
  const issues = [];
  if (!sec.found) return { facts, issues };
  for (let i = sec.bodyStart; i < sec.end; i++) {
    const m = lines[i].match(/^- `([^`]+)`:\s*(.+)$/);
    if (!m) continue;
    const id = m[1], claim = m[2];
    const fact = { id, claim, line: i, raw: lines[i], verified: null, by: null, method: null };
    if (!isKebab(id)) issues.push({ line: i, why: `fact id "${id}" is not kebab-case` });
    if (facts.some((f) => f.id === id)) issues.push({ line: i, why: `duplicate fact id "${id}"` });
    const meta = (lines[i + 1] || "").match(/^\s+verified:\s*(\S+)\s+by:\s*(\S+)\s+method:\s*(.+)$/);
    if (meta) {
      fact.verified = meta[1]; fact.by = meta[2]; fact.method = meta[3];
      if (!isIsoStamp(meta[1])) issues.push({ line: i + 1, why: `fact "${id}" verified stamp not ISO minute-Z` });
    } else {
      issues.push({ line: i, why: `fact "${id}" missing "  verified: <ISO>  by: <who>  method: <how>" line` });
    }
    facts.push(fact);
  }
  return { facts, issues };
}

// Structural upsert of a fact (replace by id, else append after last content in ## Facts).
export function upsertFact(text, { id, claim, verified, by, method }) {
  const lines = (text ?? "").split("\n");
  const sec = findSection(lines, "Facts");
  if (!sec.found) throw new Error("FACTS.md has no `## Facts` section");
  const entry = [`- \`${id}\`: ${claim}`, `    verified: ${verified}  by: ${by}  method: ${method}`];
  // find existing entry line
  let at = -1;
  for (let i = sec.bodyStart; i < sec.end; i++) {
    const m = lines[i].match(/^- `([^`]+)`:/);
    if (m && m[1] === id) { at = i; break; }
  }
  if (at !== -1) { lines.splice(at, 2, ...entry); return lines.join("\n"); }
  // append after the last non-blank line inside the section
  let insert = sec.bodyStart;
  for (let i = sec.bodyStart; i < sec.end; i++) if (lines[i].trim()) insert = i + 1;
  lines.splice(insert, 0, ...entry);
  return lines.join("\n");
}

export function daysSince(isoStamp) {
  const then = Date.parse(isoStamp.replace(/Z$/, ":00Z"));
  return Number.isNaN(then) ? Infinity : Math.floor((Date.now() - then) / 86400000);
}
