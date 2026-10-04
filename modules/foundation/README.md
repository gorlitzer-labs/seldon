# foundation

**The plan for a repo.** What is next (`docs/QUEUE.md`), what is done (`DONE.md`), what is
known to be true (`FACTS.md`). These files are written only through a small CLI, never by hand,
so a dozen agents can share them without mangling them.

| | |
|---|---|
| **Do you need it?** | Yes if you want a list of tasks your agents work through. It powers seldon's plan screen (`p`). No if you only ever start agents ad hoc. |
| **Requires** | Node 20+, git |
| **Install** | `npm i -g @gorlitzer-labs/foundation` (or `seldon install foundation`) |

## Try it (one minute)

```bash
cd ~/code/weather-cli
foundation init                                   # adds docs/ (QUEUE, DONE, FACTS…) — keeps anything you had
foundation queue "(P1) add a --units flag"
foundation queue "(P2) cache the last forecast"
foundation queue --list
```

```text
✓ queued (P1) add a --units flag  by ana
✓ queued (P2) cache the last forecast  by ana
(P1) add a --units flag
(P2) cache the last forecast
```

Then open `seldon` in that repo and press `p`: the same two items, and `⏎` starts an agent on one.
When it lands, `foundation done "add a --units flag" acme/weather-cli#12` records it.

Inspired by David Balzan's groundwork and agent-coord-mcp; ideas only, no code. See
[Credits](#credits).

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
and an agent will pick up whatever it finds. So every append records its author:

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
> agent transcript, shell history, editor store or commit could account for. An agent
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
