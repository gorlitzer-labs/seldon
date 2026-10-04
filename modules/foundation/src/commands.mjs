// The deterministic spine — every state mutation. Atomic, validated, concurrency-aware.
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { userInfo } from "node:os";
import { read, writeAtomic, appendLine, utcStamp, today } from "./lib/fs.mjs";
import { ok, info, warn, say, c } from "./lib/log.mjs";
import * as seam from "./lib/seam.mjs";
import { phaseProgress, flipCheckbox } from "./lib/progress.mjs";

const docs = (root, f) => join(root, "docs", f);
const whoami = () => process.env.FOUNDATION_AGENT || process.env.USER || userInfo().username || "unknown";
const noGlyph = (s, field) => { if (seam.hasForbiddenGlyph(s)) throw new Error(`${field} contains a forbidden glyph (—/·/•). Foundation uses ASCII: got "${s}"`); };

// ── task: flip one checkbox in an EXPLICIT phase file ──────────────────────────
export async function task(root, pos, flags) {
  const [phase, token] = pos;
  if (!phase || !token || !flags.done) throw new Error('usage: foundation task <phase> <token> --done');
  const phaseDir = join(root, "docs", "phases");
  let target = null;
  const walk = (d) => { for (const e of (safeLs(d))) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (new RegExp(`${phase}`, "i").test(p) && /tasks.*\.md$/i.test(e)) target = p; } };
  walk(phaseDir);
  if (!target) throw new Error(`no task file for phase "${phase}" under docs/phases/`);
  const text = read(target);
  const res = flipCheckbox(text, token);
  if (!res.ok) throw new Error(`no OPEN task matching "${token}" in ${rel(root, target)}`);
  writeAtomic(target, res.text);
  ok(`${rel(root, target)}: checked "${token}" → ${res.done}/${res.total} (${res.pct}%)`);
}

// ── queue: append an inbound item under ## Queue ───────────────────────────────
// ── queue --list: the open plan, for people and for tools ─────────────────────
// The one reader of QUEUE.md other tools should use (seldon's plan screen does), so the
// grammar has a single parser. --json prints [{priority, text, id, section, added, by}].
export function listQueue(root, flags = {}) {
  const { items } = seam.parseQueue(read(docs(root, "QUEUE.md")) ?? "");
  const open = items.filter((i) => !i.done)
    .map(({ priority, text, id, section, added, by }) => ({ priority, text, id, section, added, by }));
  if (flags.json) { process.stdout.write(JSON.stringify(open) + "\n"); return; }
  if (!open.length) { info("the queue is empty"); return; }
  for (const i of open) say(`(${i.priority}) ${i.text}`);
}

export async function queue(root, pos, flags) {
  if (flags.list || flags.json) return listQueue(root, flags);
  let raw = pos.join(" ").trim();
  const m = raw.match(/^\(?(P[123])\)?\s+(.+)$/);
  if (!m) throw new Error('usage: foundation queue "(P1) <text>"');
  const [, prio, txt] = m;
  noGlyph(txt, "queue text");
  const p = docs(root, "QUEUE.md");
  const text = read(p) ?? "# Queue\n\n## Queue\n";
  const lines = text.split("\n");
  const sec = seam.findSection(lines, "Queue");
  if (!sec.found) throw new Error("QUEUE.md has no `## Queue` section — run `foundation init`");
  let insert = sec.bodyStart;
  for (let i = sec.bodyStart; i < sec.end; i++) if (lines[i].trim()) insert = i + 1;
  // Every append records WHO and WHEN. QUEUE.md is an instruction channel — `/plan-phase`
  // dispatches from it and a coordinator will put a worker on what it finds — so an item
  // nobody can account for is an integrity problem, not an untidy note. On 2026-09-28 a line
  // appeared in this very file that no transcript, shell history or editor store could
  // explain; it was four days before anyone asked. An unstamped item is now visible as such.
  const who = whoami();
  lines.splice(insert, 0, `- [ ] (${prio}) ${txt}`, seam.queueProvLine(utcStamp(new Date()), who));
  writeAtomic(p, lines.join("\n"));
  ok(`queued (${prio}) ${txt}  ${c.dim("by " + who)}`);
}

// ── queue --stamp: backfill provenance for items that predate it ──────────────
// Marks them `by: unverified`, which is the truth: we do not know. It never invents an author,
// and it never touches an item that already has a stamp. One run per repo, then any unstamped
// item is new and unaccounted for.
export async function stampQueue(root) {
  const p = docs(root, "QUEUE.md");
  const text = read(p);
  if (!text) throw new Error("QUEUE.md missing — run `foundation init`");
  const { items } = seam.parseQueue(text);
  const bare = items.filter((i) => !i.provLine);
  if (!bare.length) { ok("every queue item already carries provenance"); return; }
  const lines = text.split("\n");
  // insert from the bottom up so earlier line numbers stay valid
  for (const it of [...bare].sort((a, b) => b.line - a.line)) {
    lines.splice(it.line + 1, 0, seam.queueProvLine(utcStamp(new Date()), seam.PROV_UNVERIFIED));
  }
  writeAtomic(p, lines.join("\n"));
  ok(`stamped ${bare.length} pre-existing item(s) as ${seam.PROV_UNVERIFIED}`);
  info("that records that the author is UNKNOWN - it does not vouch for them");
}

// ── stream: upsert one WORKSTREAMS row (your lane) ─────────────────────────────
export async function stream(root, pos, flags) {
  const [id, status, ...noteWords] = pos;
  if (!id || !status) throw new Error('usage: foundation stream <id> <status> [note...] [--owner X] [--branch Y]');
  const note = noteWords.join(" ");
  [id, status, note, flags.owner || "", flags.branch || ""].forEach((v) => noGlyph(String(v), "stream field"));
  const p = docs(root, "WORKSTREAMS.md");
  const text = read(p);
  if (!text) throw new Error("WORKSTREAMS.md missing — run `foundation init`");
  const { rows } = seam.parseWorkstreams(text);
  const prev = rows.find((r) => r.stream === id) || {};
  const row = {
    stream: id, owner: flags.owner || prev.owner || whoami(),
    branchWorktree: flags.branch || prev.branchWorktree || "-",
    status, blocker: flags.blocker || prev.blocker || "-", lastNote: note || prev.lastNote || "-",
  };
  writeAtomic(p, seam.upsertStreamRow(text, row));
  ok(`stream ${id} → ${status}${note ? ` (${note})` : ""}`);
}

// ── done: append a PR-cited completion line (append-only, concurrent-safe) ─────
export async function done(root, pos, _flags) {
  const [taskText, ref, date] = pos;
  if (!taskText || !ref) throw new Error('usage: foundation done "<task>" <owner/repo#N> [YYYY-MM-DD]');
  if (!seam.isRef(ref)) throw new Error(`"${ref}" is not a resolvable ref (owner/repo#N or owner/repo@sha). done must cite a PR.`);
  noGlyph(taskText, "done task");
  const d = date || today(new Date());
  if (!seam.isIsoDate(d)) throw new Error(`date "${d}" is not YYYY-MM-DD`);
  const p = docs(root, "DONE.md");
  if (!read(p)) throw new Error("DONE.md missing — run `foundation init`");
  appendLine(p, `- [x] ${taskText} [${ref}] [${d}]`);   // O_APPEND — safe under concurrent writers
  ok(`done: ${taskText} [${ref}] [${d}]`);
}

// ── fact: record a verified fact, tool-stamped; --verify runs a check first ────
export async function fact(root, pos, flags) {
  const [id, claim] = pos;
  if (!id || !claim) throw new Error('usage: foundation fact <kebab-id> "<claim>" [--verify "<cmd>"] [--by <who>]');
  if (!seam.isKebab(id)) throw new Error(`fact id "${id}" must be kebab-case`);
  noGlyph(claim, "fact claim");
  let method = "asserted (no check run)";
  if (flags.verify && flags.verify !== true) {
    info(`verifying: ${flags.verify}`);
    try { execSync(flags.verify, { stdio: "inherit", cwd: root }); }
    catch { throw new Error(`verify command failed — fact NOT written (a claim is a hypothesis until it passes)`); }
    method = flags.verify;
  }
  const p = docs(root, "FACTS.md");
  if (!read(p)) throw new Error("FACTS.md missing — run `foundation init`");
  const entry = { id, claim, verified: utcStamp(new Date()), by: flags.by || whoami(), method };
  writeAtomic(p, seam.upsertFact(read(p), entry));
  ok(`fact \`${id}\` verified ${entry.verified} by ${entry.by}`);
}

// ── decision: allocate an ADR number + index row atomically ────────────────────
export async function decision(root, pos, _flags) {
  const title = pos.join(" ").trim();
  if (!title) throw new Error('usage: foundation decision "<title>"');
  noGlyph(title, "decision title");
  const p = docs(root, "DECISIONS.md");
  const text = read(p) ?? "# Decisions (ADRs)\n\n## Index\n\n";
  const nums = [...text.matchAll(/ADR-(\d{4})/g)].map((m) => parseInt(m[1], 10));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  const id = `ADR-${String(n).padStart(4, "0")}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const lines = text.split("\n");
  const idx = seam.findSection(lines, "Index");
  const idxRow = `- ${id} — ${title} — _Proposed_`;
  if (idx.found) lines.splice(idx.end, 0, idxRow); else lines.push("## Index", "", idxRow);
  lines.push("", `## ${id}: ${title}`, "", "**Status:** Proposed", "", "**Context:** _why now; what forces this_", "", "**Decision:** _what we chose_", "", "**Consequences:** _trade-offs accepted_", "", "**Alternatives considered:** _rejected options + why_", "");
  writeAtomic(p, lines.join("\n"));
  ok(`allocated ${id} (${slug}) — fill in the stub in docs/DECISIONS.md`);
}

// ── status: computed phase progress + next queue item ──────────────────────────
export async function status(root) {
  const { per, overall } = phaseProgress(root);
  say(c.bold("Foundation status"));
  if (per.length === 0) info("no phase task files yet (docs/phases/*/…_TASKS.md)");
  for (const f of per) say(`  ${rel(root, f.file)}  ${bar(f.pct)} ${f.done}/${f.total}`);
  if (per.length) say(`  ${c.bold("overall")}          ${bar(overall.pct)} ${overall.done}/${overall.total} (${overall.pct}%)`);
  const q = seam.parseQueue(read(docs(root, "QUEUE.md")) || "");
  const next = q.items.find((i) => !i.done);
  say("");
  say(next ? `${c.cyan("next")}  (${next.priority}) ${next.text}` : c.dim("queue empty"));
  const ws = seam.parseWorkstreams(read(docs(root, "WORKSTREAMS.md")) || "");
  if (ws.rows.length) say(`${c.cyan("streams")}  ${ws.rows.map((r) => `${r.stream}:${r.status}`).join("  ")}`);
}

// ── versions: polyglot dep freshness (npm implemented; others detected) ────────
export async function versions(root, flags) {
  const eco = detectEco(root);
  if (eco.length === 0) { warn("no recognized manifest (package.json / pyproject / Cargo.toml / go.mod)"); return; }
  let behind = 0;
  for (const e of eco) {
    if (e === "npm") {
      const pkg = JSON.parse(read(join(root, "package.json")));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, spec] of Object.entries(deps)) {
        const pinned = String(spec).replace(/^[\^~]/, "");
        let latest;
        try { latest = execSync(`npm view ${name} version`, { encoding: "utf8" }).trim(); } catch { warn(`${name}: registry lookup failed`); continue; }
        const majPin = pinned.split(".")[0], majLat = latest.split(".")[0];
        if (majPin !== majLat) { say(`  ${c.red("🔴")} ${name}  ${pinned} → ${latest} (major)`); behind++; }
        else if (pinned !== latest) say(`  ${c.yellow("🟡")} ${name}  ${pinned} → ${latest}`);
        else if (flags.all) say(`  ${c.green("✅")} ${name}  ${pinned}`);
      }
    } else {
      warn(`${e}: freshness check not implemented yet (detected ${e})`);
    }
  }
  if (behind) { say(c.red(`\n${behind} package(s) a major behind`)); process.exit(1); }
  ok("no major drift");
}

// helpers
const safeLs = (d) => { try { return readdirSync(d); } catch { return []; } };
const rel = (root, p) => p.replace(root + "/", "");
const bar = (pct) => { const w = 16, f = Math.round((pct / 100) * w); return c.green("█".repeat(f)) + c.dim("░".repeat(w - f)); };
function detectEco(root) {
  const has = (f) => read(join(root, f)) !== null;
  const e = [];
  if (has("package.json")) e.push("npm");
  if (has("pyproject.toml") || has("requirements.txt")) e.push("pip");
  if (has("Cargo.toml")) e.push("cargo");
  if (has("go.mod")) e.push("go");
  return e;
}
