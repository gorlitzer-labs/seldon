# foundation

**the seam** — a lean, **deterministic** project workflow you bolt onto any repo: the plan a codebase and its agents follow.

It runs standalone — solo or under any orchestrator — and pairs with **apiary** when agents coordinate over it. Nothing here imports apiary.

Foundation is inspired by David Balzan's [groundwork](https://www.npmjs.com/package/@davidbalzan/groundwork)
(an installable AI development workflow of skills + doc methodology) and by the writer-split seam of
[agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp) /
[`@davidbalzan/groundwork-seam`](https://www.npmjs.com/package/@davidbalzan/groundwork-seam). We took
the ideas, not the code: Foundation's center of gravity is the **deterministic spine** — every state
mutation goes through a concurrency-safe, atomic, ASCII-validated command, and the model never
hand-edits state. See [Credits](#credits) for what came from where.

Lives in the [`gorlitzer-labs/seldon`](https://github.com/gorlitzer-labs/seldon/tree/main/modules/foundation)
monorepo at `modules/foundation`, published to npm as `@gorlitzer-labs/foundation`.

```bash
npm i -g @gorlitzer-labs/foundation   # install the CLI
foundation init                       # install the seam + doc scaffold + skills into the current repo
```

## The seam (writer-split — one writer per file, the filesystem *is* the concurrency control)

| File | Holds | Writer | Grammar (all ASCII) |
|------|-------|--------|---------------------|
| `docs/QUEUE.md` | inbound work | `/plan-phase` / human | `- [ ] (P1) <text>` |
| `docs/QUEUE.md` | inbound work, not yet claimed | `/plan-phase` or a human | `- [ ] (P1) <text>` + `    added: <ISO>  by: <who>` |
| `docs/WORKSTREAMS.md` | live lane state | each lane owner | 6-col pipe table |
| `docs/DONE.md` | completion log (append-only) | the executor | `- [x] <task> [owner/repo#N] [YYYY-MM-DD]` |
| `docs/FACTS.md` | verified world-state | whoever verified | `` - `id`: claim `` + `verified: <ISO> by: <who> method: <how>` |

## Commands (the spine)

```
foundation init [dir]                    install the seam + docs
foundation queue "(P1) <text>"           append an inbound item (stamped: who + when)
foundation queue --stamp                 backfill provenance on pre-existing items, as "unverified"
foundation task <phase> <token> --done   flip one checkbox; recompute progress
foundation stream <id> <status> [note]   upsert your lane's row
foundation done "<task>" <ref> [date]    append a PR-cited completion line
foundation fact <id> "<claim>" --verify "<cmd>"   record a fact — only if the check passes
foundation decision "<title>"            allocate an ADR number + index row
foundation status                        computed phase progress + next item
foundation versions [--all]              polyglot dep freshness (exit≠0 on major drift)
foundation doctor                        flag doc↔reality drift + ADR reversals (CI, exit≠0)
```

## Queue provenance — why `doctor` fails on an unattributed item

`docs/QUEUE.md` is an **instruction channel**, not a notepad. `/plan-phase` dispatches from it
and a coordinator will put a worker on whatever it finds. So every append records its author:

```
- [ ] (P1) sail to reefstack and dive the wreck
    added: 2026-10-02T10:10Z  by: claude-opus-5
```

The tool writes that line; you never do. Set `FOUNDATION_AGENT` so an agent is recorded under
its own name rather than the logged-in human's.

An item with **no** `added:`/`by:` line is reported by `foundation doctor` as **drift**, with a
non-zero exit — it is work the pipeline would treat as authorized and that nobody can account
for. Staleness (an item open longer than `QUEUE_STALE_DAYS`, 7) is only a *note*, because a
long-lived P3 is normal and an attention signal you see every day stops being one.

Migrating a repo that predates this: `foundation queue --stamp` marks existing items
`by: unverified`. That records that the author is **unknown** — it never invents one, and never
touches an item that already has a stamp.

> This exists because of a real incident. On 2026-09-28 a queue item appeared in a repo that no
> agent transcript, shell history, editor store or commit could account for. A coordinator
> noticed and escalated — as prose, into a room nobody was reading — and it sat for four days.
> `factory watch` now *files* an unaccounted item as a pending decision, so it reaches the human
> instead of scrolling past.

## Skills (the thin layer)

`foundation init` also installs a skill layer: one `SKILL.md` source per skill, installed verbatim for
Claude Code (`.claude/skills/`) and mirrored to Cursor (`.cursor/commands/`), Copilot
(`.vscode/prompts/`), and Codex (`.codex/prompts/`). The model runs the workflow; the spine commands
above own every state mutation.

`/kickstart` · `/prd` · `/intake` · `/plan-phase` · `/orient` · `/branch` · `/verify` · `/decision` · `/glossary`

## What we changed from groundwork

- **No load-bearing invisible Unicode.** The grammar is ASCII and *validated at write time* — a
  forbidden glyph fails loudly at authoring, not silently at parse.
- **Verify, don't guess.** Progress is counted, versions are queried, facts carry `when·who·how` and
  the tool stamps the time. `fact --verify` writes only if the check passes.
- **Loud on the unknown.** A malformed row is preserved verbatim, line-numbered, and surfaced by
  `doctor` — never dropped, never read as empty.
- **Enforced, not advised.** `done` refuses without a ref; single-writer/append-only live in the
  writers, not in a comment.
- **The ADR reversal tripwire.** `doctor` greps the real dependency tree against what "Accepted" ADRs
  said they rejected — catching decisions that were silently reversed.

Status: **spine + skill layer complete** (v0.1). Next: the apiary `room create` hook (nothing here
imports apiary yet). See `DESIGN.md`.

## Credits

Foundation was inspired by, and deliberately diverges from:

- **[groundwork](https://www.npmjs.com/package/@davidbalzan/groundwork)** by David Balzan — the
  writer-split seam (QUEUE / WORKSTREAMS / DONE / FACTS), the ADR-reversal tripwire, the version
  single-source-of-truth and tool-stamped facts all come from here.
- **[agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp)** and
  **[`@davidbalzan/groundwork-seam`](https://www.npmjs.com/package/@davidbalzan/groundwork-seam)** —
  header-driven schema detection, loud-on-unknown grammar, malformed rows preserved verbatim, and the
  library-twin-of-script pattern.

No code is vendored or imported from either; Foundation owns its own ASCII seam format. The full
adopt / diverge rationale is in [`DESIGN.md`](DESIGN.md) §3, §4a and §7.
