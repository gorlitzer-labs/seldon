# Foundation 🐝

> A lean, **deterministic** project-development workflow you bolt onto any repo — the beekeeper's
> *foundation sheet* that guides how the comb gets built.

Foundation pairs with **apiary** (the transport) and the **Hive Manifest** (the protocol): apiary
moves messages, the Manifest says how agents behave, **Foundation is the substrate they coordinate
over.** It runs standalone too — solo or under any orchestrator. Nothing here imports apiary.

It is *not* groundwork. Its center of gravity is the **deterministic spine**: every state mutation
goes through a concurrency-safe, atomic, ASCII-validated command — the model never hand-edits state.

```bash
npx github:gorlitzer/foundation init      # install the seam + doc scaffold into the current repo
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

Status: **spine complete** (v0.1). Next: the thin skill layer (`/prd /kickstart /plan-phase /verify
/branch /intake`) and the apiary `room create` hook. See `DESIGN.md`.
