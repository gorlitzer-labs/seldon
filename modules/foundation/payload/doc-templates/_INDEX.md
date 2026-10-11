# Docs Index

**The seam** — writer-split, one writer per file (the filesystem boundary is the concurrency control):

| File | Holds | Sole writer |
|------|-------|-------------|
| QUEUE.md | inbound work | `/plan-phase` or human |
| WORKSTREAMS.md | live lane state | each lane owner (its row) |
| DONE.md | completion log (append-only, PR-cited) | the executor |
| FACTS.md | verified world-state | whoever verified (`foundation fact`) |

**Durable docs:** STACK_MAP (versions SSoT) · DECISIONS (ADRs) · CONTEXT (glossary) · phases/ (tasks).

Status is **computed** by `foundation status` — never hand-copied into a second place. Drift is caught
by `foundation doctor`.
