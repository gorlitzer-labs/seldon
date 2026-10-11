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
