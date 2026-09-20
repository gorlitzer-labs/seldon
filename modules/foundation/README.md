# foundation

**the seam** — a lean, **deterministic** project workflow you bolt onto any repo: the plan a codebase and its agents follow.

It runs standalone — solo or under any orchestrator — and pairs with **apiary** when agents coordinate over it. Nothing here imports apiary.

It is *not* groundwork. Its center of gravity is the **deterministic spine**: every state mutation
goes through a concurrency-safe, atomic, ASCII-validated command — the model never hand-edits state.

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
| `docs/WORKSTREAMS.md` | live lane state | each lane owner | 6-col pipe table |
| `docs/DONE.md` | completion log (append-only) | the executor | `- [x] <task> [owner/repo#N] [YYYY-MM-DD]` |
| `docs/FACTS.md` | verified world-state | whoever verified | `` - `id`: claim `` + `verified: <ISO> by: <who> method: <how>` |

## Commands (the spine)

```
foundation init [dir]                    install the seam + docs
foundation queue "(P1) <text>"           append an inbound item
foundation task <phase> <token> --done   flip one checkbox; recompute progress
foundation stream <id> <status> [note]   upsert your lane's row
foundation done "<task>" <ref> [date]    append a PR-cited completion line
foundation fact <id> "<claim>" --verify "<cmd>"   record a fact — only if the check passes
foundation decision "<title>"            allocate an ADR number + index row
foundation status                        computed phase progress + next item
foundation versions [--all]              polyglot dep freshness (exit≠0 on major drift)
foundation doctor                        flag doc↔reality drift + ADR reversals (CI, exit≠0)
```

## Skills (the thin layer)

`foundation init` also installs a skill layer: one `SKILL.md` source per skill, installed verbatim for
Claude Code (`.claude/skills/`) and mirrored to Cursor (`.cursor/commands/`), Copilot
(`.vscode/prompts/`), and Codex (`.codex/prompts/`). The model runs the workflow; the spine commands
above own every state mutation.

`/kickstart` · `/prd` · `/intake` · `/plan-phase` · `/orient` · `/branch` · `/verify` · `/decision` · `/glossary`

## Why it's better than the thing it learned from

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
