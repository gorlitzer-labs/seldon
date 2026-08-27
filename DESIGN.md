# Foundation — Design Spec (v0.1 draft)

> **Foundation** is a lean, installable project-development workflow you bolt onto any repo — the
> beekeeper's *foundation sheet* that guides how the comb gets built. It pairs with **apiary**
> (the transport) and the **Hive Manifest** (the protocol): apiary moves messages, the Manifest
> says how agents behave, Foundation is the **project substrate they coordinate over**.
>
> It is *not* a copy of David's `groundwork`. It's the coherent system groundwork points at but
> deliberately isn't — with a deterministic core, a multi-agent-native seam, and the gaps groundwork
> leaves open (verify, git, intake) filled in.

Status: design draft for Franco's review. No code yet. Decisions locked so far are in §0.

---

## 0. Locked decisions

- **Name:** Foundation.
- **Relationship to apiary:** a *separate lean package*, **auto-invoked** by apiary on project
  creation (`apiary room create` / a new `apiary new` runs `foundation init <repo>`). Apiary stays
  the lean transport we de-bloated; Foundation is its own concern.
- **Center of gravity: the deterministic spine first.** Scripts + `doctor` + the ADR tripwire *are*
  the core. Skills are a thin narrative layer over them. **Every state mutation goes through a
  concurrency-safe script** — the LLM never hand-edits state files.
- **Multi-agent-native.** The writer-split seam is a first-class primitive, driven by apiary's
  lane-owned rooms and governed by the Manifest.
- **Apiary-agnostic.** Foundation runs fully standalone — solo, or under any orchestrator. The apiary
  hook is *additive*, never required. Nothing in the spine or seam imports apiary.
- **Multi-harness** (following apiary's model). Skills live as one Claude-Code `SKILL.md` source and
  mirror to Cursor + VS Code Copilot (+ Codex) via a clean, Foundation-owned adapter — no vendored
  third-party dep. The spine (`foundation` CLI) is harness-independent by construction: it's just
  scripts, callable from any assistant or from CI with no model at all.
- **/verify default: light, escalate on risk.** The gate runs typecheck + tests + an independent
  behavior check by default; it escalates to isolated-worktree + named mutation-kill (+ prod
  before/after for changed numbers) only for money/high-risk changes.
- **Distribution:** `npx github:gorlitzer/foundation init` (like groundwork). Init-into-existing
  (or new) repos only — no starter template in v1.

---

## 1. Principles

1. **Verify, don't guess.** If a fact is computable (progress %, dep version, "does X exist"), a
   script computes it and `doctor` fails on drift. The model never asserts a computable fact.
2. **One writer per file.** The seam's concurrency control *is* the filesystem boundary — no locks.
3. **Structural mutation only.** State files are edited by scripts that touch one row / append one
   line atomically (temp-file + rename, or `O_APPEND`). A model dropping a glyph can't corrupt state.
4. **Single source of truth per fact.** Versions live in exactly one doc; progress is computed from
   checkboxes, never restated. Nothing is hand-copied into a second place to rot.
5. **Lean and polyglot.** Zero build, near-zero deps. Ecosystem-specific logic (npm/pip/cargo) is
   detected, not assumed. Stack *recipes* live in starter templates, never in the universal core.
6. **Scales from solo to swarm.** Solo pays no swarm tax (ceremony collapses to a one-liner);
   multi-agent gets the full seam. Same tool, two intensities.

---

## 2. Architecture — three layers, bottom-up

```
┌─ Layer 3 · SKILLS (thin narrative) ───────────────────────────────┐
│  /prd  /kickstart  /plan-phase  /glossary  /decision  /orient      │
│  + gap-fillers: /verify  /branch  /intake                          │
│  (gather intent, call the scripts; never hand-edit state)          │
├─ Layer 2 · THE SEAM (state model, writer-split) ──────────────────┤
│  QUEUE.md → WORKSTREAMS.md → DONE.md → FACTS.md  (one writer each)  │
│  + phase task docs (the load-bearing checkboxes)                   │
│  + STACK_MAP (version SSoT) · DECISIONS (ADRs) · CONTEXT (glossary)│
├─ Layer 1 · THE SPINE (deterministic core) ────────────────────────┤
│  foundation {task,stream,done,fact,decision,queue,versions}        │
│  foundation status · foundation doctor (+ ADR tripwire)            │
│  every mutation atomic + concurrency-safe; every check exit-coded  │
└────────────────────────────────────────────────────────────────────┘
              apiary (transport)  +  Hive Manifest (protocol)
              drive the seam via lane-owned rooms
```

The inversion from groundwork: **the spine is the product; the skills are a convenience over it.**
Everything a skill does to *state* is a script call, so the same operations work headless, in CI,
or from an apiary worker with no model in the loop.

---

## 3. Layer 1 — the deterministic spine (the core we build first)

Each is a small `.mjs` (or single binary later), atomic, exit-coded, concurrency-safe.

| Command | Does | Safety |
|---|---|---|
| `foundation task <phase> <id> --done` | Flip one checkbox in an **explicit** phase file; recompute the phase's Overall Progress from the boxes. | Requires explicit phase (kills groundwork's "active = most-open-boxes" race under parallel phases). Atomic rewrite. |
| `foundation stream <id> <status> [note]` | Structural upsert of one `WORKSTREAMS` row; everything else (incl. coordinator-extension fences) preserved byte-for-byte. | Row-scoped edit — two workers on different rows never clobber. |
| `foundation done "<ref> — <summary>"` | Append one line to the append-only completion log. Requires a resolvable ref (PR/commit) or it refuses. | `O_APPEND` — lock-free concurrent appends. Fills groundwork's missing DONE writer. |
| `foundation fact <id> "<claim>" [--verify "<cmd>"]` | Upsert a FACTS entry, **tool-stamped** `verified: <utc> · <who> · <how>`. With `--verify`, run the cmd and **only write if it passes**. | Atomic upsert. Closes the "claimed a check that never ran" gap. |
| `foundation decision "<title>"` | Allocate the next ADR number + insert the index row atomically; return the stub for the skill to fill with prose. | No off-by-one / forgotten index row. |
| `foundation queue "<item>"` | Append one inbound item to QUEUE (single-writer: only `/plan-phase`). | Append-only. |
| `foundation versions [--all]` | Detect the ecosystem(s) (npm/pnpm/yarn/pip/cargo/go), compare pinned vs latest, **exit non-zero on a major behind**, reconcile STACK_MAP's latest-stable + last-audited. | Polyglot (fixes groundwork's npm-only). |
| `foundation status` | Deterministic phase/progress from checkboxes — the *only* place status is computed. | Read-only. |
| `foundation doctor` | Run every check + the **ADR tripwire** + **seam integrity** (each seam file has exactly one writer's shape; no orphan wikilinks; no phase 100%-but-roadmap-stale; no stale FACTS past TTL). Exit non-zero on any drift. | Read-only, CI-friendly. |

**Ported wholesale from groundwork** (the genuinely great ideas): the ADR-reversal tripwire
(grep the real dep tree against what "Accepted" ADRs rejected), version SSoT, tool-stamped FACTS.
**Upgraded:** `fact --verify` (verify-then-write), polyglot `versions`, explicit-phase `task`,
append-safe `done`, structural `stream`.

---

## 4. Layer 2 — the seam (state model)

The four writer-split files (adopted wholesale — the best idea in groundwork, and it maps 1:1 onto
apiary lane-owned rooms):

| File | Role | Sole writer |
|---|---|---|
| **QUEUE.md** | Inbound work, not yet claimed | `/plan-phase` (+ human/liaison) |
| **WORKSTREAMS.md** | Live in-flight state, one row per lane | each lane owner (its own row) |
| **DONE.md** | Append-only completion log, PR-cited | the executor that finished |
| **FACTS.md** | Settled, verified world-state | whoever verified (tool-stamped) |

Plus the durable docs: **phase task files** (the load-bearing checkboxes), **STACK_MAP** (version
SSoT), **DECISIONS** (immutable ADRs), **CONTEXT** (glossary). **Cut from groundwork:** the
per-phase README "Quick Stats" (fabricated line counts / coverage nobody reads), and the
status-restated-in-4-places redundancy — status is computed once by `foundation status`, everything
else links to it.

### 4a. Seam grammar — the interop contract (from the coord-mcp 0.19→0.26 diff)

The seam grammar is now a **standalone package `@davidbalzan/groundwork-seam`** (coord-mcp 0.26
depends on `0.1.4`; groundwork vendors `0.1.0`). Foundation must produce files that **round-trip**
with it. The pinned contract:

- **Glyphs (load-bearing bytes):** ` — ` = U+2014 space-padded; ` · ` = U+00B7 space-padded. ASCII
  hyphen/period silently breaks parsing.
- **QUEUE.md** — under `## Queue`: `- [ ] (P1|P2|P3) text` (priority mandatory).
- **DONE.md** — under `## Done`: `- [x] <task> — owner/repo#N · YYYY-MM-DD` (ref single-token, ISO date).
- **WORKSTREAMS.md** — **v1, 6 columns, verbatim header:** `| Stream | Owner / Agent | Branch · Worktree | Status | Blocker | Last note |` + `|---|` row; every data row exactly 6 cells. (The old 5-col `lanes-v0` is deprecated and a *refused* write target — never emit it.)
- **FACTS.md** — under `## Facts`: `- \`kebab-id\` — claim` + indented `  verified: YYYY-MM-DDTHH:MMZ · by: X · method: Y`; ids kebab + unique; **14-day staleness** → re-verify or delete.
- **scopes.json** (`~/agent-coord/scopes.json`) — advisory who-writes-which-doc; `{owner, mode ∈ exclusive|append-only|shared}`.

**Adopt from 0.26 (best new ideas):**
- FACTS as the settled tier with `verified/by/method` + 14-day `doctor` tripwire.
- **Header-driven schema classification; unknown grammar → loud `warning`, never silently empty.**
  (This is the antidote to the real "parser returned zero rows, UI blank, no error" incident.)
- **Malformed row → refuse the record, replay the bytes exactly, name the line #.** One bad row never
  drops the doc.
- Markdown is authoritative; any index is rebuildable ("delete the store, lose nothing"); refuse to
  export from an empty store (never blank a real doc).
- Advisory scopes + **git last-writer-vs-declared-owner** drift check in `doctor`.
- Deterministic content-hash ids (never written into the markdown — they'd change the round-trip bytes).
- The **library-twin-of-script** pattern (a deterministic writer exposed as both a script and a lib fn, tested to agree).

**Diverge deliberately (do NOT copy):**
- The glyph-exactness is fragile *by admission*. Foundation matches it for interop but adds a
  **write-time lint that rejects ASCII look-alikes** so a bad glyph fails loudly at authoring, not
  silently at parse. Where Foundation owns a format end-to-end, prefer a delimiter that can't be ASCII-confused.
- **No `~/agent-coord/` assumption, no git-required assumption** (guard both), **no tmux/transport
  coupling** — the dependency is one-way (orchestrator → seam, never reverse).
- coord's scopes are **advisory-only because the bus isn't the write path**. Foundation **owns the
  write path**, so it *enforces* single-writer / append-only in its scripts rather than only advising.
- Don't trust the shipped CHANGELOG for the contract — authoritative source is the seam package + the
  doc templates.

**Open decision (§8b):** how Foundation obtains this grammar — see below.

---

## 5. Layer 3 — the skills (thin, ~7 spine + 3 gap-fillers)

Spine (12 groundwork skills collapse to these):

| Skill | Job | Backed by |
|---|---|---|
| `/prd` | One discovery interview → PRD.md (with a `--lite` mode for small projects). | — |
| `/kickstart` | PRD → doc scaffold + seam init. **Slimmed:** no stack recipes, no per-phase quick-stats. | `foundation init` |
| `/plan-phase` | Phase → executable tasks + **interface/contract stubs** (the hand-off unit for apiary workers) + confidence report; appends to QUEUE. | `foundation queue` |
| `/glossary` | Pin vocabulary → CONTEXT (merges groundwork's create-prd key-terms + domain-model, at two depths). | — |
| `/decision` | Write an ADR (3-of-3 gate); scope flag `--project`/`--global` (merges log-decision + remember). | `foundation decision` |
| `/orient` | "Where am I / what's next" — **lane-aware** (my room/stream/branch, not the whole board). Merges next + start-session. | `foundation status` |
| *(state)* | Marking work: surfaced as `foundation task/stream/done/fact` directly, or via `/orient`. | the spine |

The three gaps groundwork leaves — and you require — as first-class skills:

| Skill | Fills |
|---|---|
| `/verify` | **The QA gate.** Default: typecheck + tests + an independent behavior check. **Escalates** to isolated-worktree + named mutation-kill (+ prod before/after for changed numbers) only for money/high-risk changes. Records the result as `foundation fact --verify` (verify-then-write). Gates DONE. |
| `/branch` | **Git/PR/worktree.** Creates the lane worktree + branch off fresh main, opens the PR — the moves the Manifest describes but nothing automates. |
| `/intake` | **Existing-repo onboarding.** Reverse-engineers PRD / CONTEXT / STACK_MAP from a codebase, so "bolt onto any repo" is real, not greenfield-only. |

---

## 6. Apiary integration (how it "always follows")

- **Trigger:** `apiary room create` (which already runs a repo-picker) — after the repo is chosen,
  it invokes `foundation init <repo>` if the repo isn't already on Foundation. A new alias
  `apiary new <name>` = create repo + `foundation init` + open the hive.
- **Division of labour** (clean, no overlap):
  - **apiary** = transport (rooms, messages, presence). Unchanged, lean.
  - **Hive Manifest** = protocol (how agents behave — lanes, no-clobber, merge gate). Already merged.
  - **Foundation** = substrate (the seam + phase tasks + verified facts the agents coordinate over).
- The coord roles (coordinator/worker/QA) read/write the seam per the writer-split; `/orient` gives
  each worker its lane view; `/verify` is the QA role's gate; `foundation doctor` is the CI signal.
- **Nothing about Foundation requires apiary** — it runs solo too (the seam is a one-row degenerate
  case). Apiary just makes the multi-writer case light up.

---

## 7. Deliberately dropped from groundwork

- `add-data-layer` (Drizzle/Postgres recipe) and kickstart's pino-logging block → belong in *starter
  templates*, not the universal workflow.
- Per-phase README "Quick Stats" (fabricated numbers) → gone.
- Status restated in 4 docs → computed once.
- npm-only assumptions → polyglot.
- Emoji/exact-Unicode-glyph as load-bearing data → replaced with parser-tolerant markers where the
  seam scripts read state (glyphs are display-only).

---

## 8. Resolved (2026-08-27)

1. **Harness targets:** **multi-harness** — Claude Code `SKILL.md` source, mirrored to Cursor +
   Copilot (+ Codex) via a Foundation-owned adapter (no vendored dep). Foundation stays
   **apiary-agnostic / standalone**. (§0, §1)
2. **`/verify` depth:** **light default, escalate on risk.** (§0, §5)
3. **Distribution:** **`npx github:gorlitzer/foundation init`**, init-into-existing only. (§0)
4. **Starter template:** **no** in v1 — bolt-onto-existing only.

### 8b. Seam-grammar decision — RESOLVED: detach completely, own it, do better

Foundation uses its **own seam format** — no dependency on `@davidbalzan/groundwork-seam`, no
obligation to match David's fragile exact-glyph contract. Foundation's orchestrator is apiary (its
own), so coord-mcp interop isn't required; if ever wanted it's an explicit export/import bridge, not a
design constraint. We keep the *ideas* from the diff (§4a "adopt" list) and fix the weaknesses.

**"Do better" = kill the load-bearing invisible Unicode.** Foundation's grammar is ASCII-unambiguous,
visible, and validated at write time:

- **QUEUE.md** (`## Queue`): `- [ ] (P1) <text>`  — parens+priority, ASCII.
- **DONE.md** (`## Done`, append-only): `- [x] <task> [<owner/repo#N>] [<YYYY-MM-DD>]`  — bracketed
  ref + date, un-confusable, ref required (script refuses without it).
- **WORKSTREAMS.md**: 6-col pipe table `| Stream | Owner | Branch/Worktree | Status | Blocker | Last note |`
  — arity-checked, ASCII `/` not a middot.
- **FACTS.md** (`## Facts`): `` - `<kebab-id>`: <claim> `` then indented
  `  verified: <ISO>  by: <who>  method: <how>`  — `label: value` anchors, no em-dash/middot.
- Every file may carry an optional `<!-- foundation:schema queue.v1 -->` header (detection also works
  structurally). Records get **content-hash ids**, never written into the markdown.

**Guarantees the scripts enforce (better than coord's advisory-only):** write-time validation that
rejects malformed rows *and* ASCII-look-alike-of-a-forbidden-glyph; single-writer / append-only
enforced in the writer, not merely declared; unknown grammar → loud warning, never silently empty;
malformed row → preserved verbatim + line-numbered, never drops the doc; markdown authoritative, any
index rebuildable; refuse to write from an empty store.

---

## 9. Build plan (once this spec is approved)

1. **Spine** — `foundation` CLI skeleton + the deterministic scripts + `doctor` + tripwire (the core;
   runnable and testable on its own).
2. **Seam templates** — the four writer-split files + phase/STACK_MAP/DECISIONS/CONTEXT templates.
3. **Skills** — the ~7 spine skills as thin wrappers over the spine.
4. **Gap-fillers** — `/verify`, `/branch`, `/intake`.
5. **Apiary hook** — `foundation init` invoked from `apiary room create` / `apiary new`.
6. **Dogfood** — run Foundation on a real project via an apiary hive (like today's timer demo, but
   now the agents coordinate over the seam).
