# Queue
<!-- foundation:schema queue.v2 -->

Inbound work, not yet claimed. **Single writer:** `/plan-phase` (or a human/liaison). Executors
never edit this file. Grammar (ASCII, no fancy glyphs):

    - [ ] (P1) <text>          priority is P1 | P2 | P3
        added: <ISO minute-Z>  by: <who>

Use `foundation queue "(P1) <text>"` to append — never hand-edit. The `added:`/`by:` line is
written by the tool, never by you; set `FOUNDATION_AGENT` so an agent is recorded under its own
name instead of the human's.

**Why provenance is mandatory here.** This file is an instruction channel, not a notepad:
`/plan-phase` dispatches from it and a coordinator will put a worker on whatever it finds. An
item with no recorded author is work the pipeline would treat as authorized and that nobody can
account for, so `foundation doctor` reports it as **drift** and exits non-zero. Run
`foundation queue --stamp` once per repo to mark items that predate this as `by: unverified` —
which records that the author is unknown, and never guesses one.

## Queue
- [ ] (P1) supervisor re-joins a hive that restarted: watch.mjs captures the room session token ONCE at boot, so any hive whose room restarts afterwards reports 0 online forever - reproduced 2026-10-02, stranded showed 0 online with Coordinator in the room
    added: 2026-10-02T10:10Z  by: claude-opus-5
- [ ] (P2) watch.mjs re-derives queueOpen/done/lanes/drift inline instead of calling hiveState() - a second parser of the Foundation seam inside the same package, which is exactly what state.mjs's header warns against. Fold the supervisor tick onto hiveState and delete the duplicate reads
    added: 2026-10-02T10:10Z  by: claude-opus-5
- [ ] (P3) Makefile + help pass across modules: apiary and bifrost have Makefiles, nothing else does, and no Makefile mentions the go/panel flow. Decide whether Makefiles are the convention or drop them, then make every module's --help agree with its README
    added: 2026-10-02T10:10Z  by: claude-opus-5
- [ ] (P2) apiary should export FOUNDATION_AGENT=<agent name> into each agent's tmux pane, so foundation queue records the agent as the author instead of the logged-in human - without it every agent-added queue item reads by: francesco.berardi
    added: 2026-10-02T10:11Z  by: claude-opus-5
