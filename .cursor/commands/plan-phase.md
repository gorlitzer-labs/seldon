# /plan-phase

Turn a phase into executable, contract-bearing tasks + one queue item. The hand-off unit a coordinator dispatches to workers.

# plan-phase `<phase#> <name>`

The second half of the spine: `/prd` and `/kickstart` define *what*; this defines *how, in chunks a
worker can execute in parallel*. **Sole writer of `QUEUE.md`** (via `foundation queue`) — never edit
DONE/WORKSTREAMS here.

1. **Scope & analyze.** Read the roadmap, `docs/ARCHITECTURE_GUIDE.md`, and `docs/CONTEXT.md`; use the
   canonical terms. State the phase's goal and its boundaries (what's explicitly out).
2. **Break into tasks.** 4–6 tasks, each 3–7 sub-steps, sized to the phase (don't pad). For each task
   give **interfaces / contracts — signatures only** (the thing a worker needs to build in isolation
   without reading the rest). Mark priorities + cross-task deps.
3. **Confidence report.** End with a `## Low-confidence decisions` list — the calls you're unsure of.
   They're cheap to fix now, expensive after code exists.
4. **Write the task doc.** `docs/phases/phase<N>/PHASE<N>_TASKS.md` with `- [ ] (N.M) <task>` checkboxes
   and an `**Overall Progress:** 0/0 (0%)` line (kept correct by `foundation task`, never by hand).
5. **Queue it.** `foundation queue "(P1) Phase <N>: <name> — ready to claim"` (one item per phase).

Report the task doc path and the queue item. Workers then claim via the coordinator + `/orient`.
