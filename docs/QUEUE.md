# Queue
<!-- foundation:schema queue.v1 -->

Inbound work, not yet claimed. **Single writer:** `/plan-phase` (or a human/liaison). Executors
never edit this file. Grammar (ASCII, no fancy glyphs):

    - [ ] (P1) <text>          priority is P1 | P2 | P3

Use `foundation queue "(P1) <text>"` to append — never hand-edit.

## Queue
- [ ] (P1) supervisor re-joins a hive that restarted: watch.mjs captures the room session token ONCE at boot, so any hive whose room restarts afterwards reports 0 online forever - reproduced 2026-10-02, stranded showed 0 online with Coordinator in the room
- [ ] (P2) watch.mjs re-derives queueOpen/done/lanes/drift inline instead of calling hiveState() - a second parser of the Foundation seam inside the same package, which is exactly what state.mjs's header warns against. Fold the supervisor tick onto hiveState and delete the duplicate reads
- [ ] (P3) Makefile + help pass across modules: apiary and bifrost have Makefiles, nothing else does, and no Makefile mentions the go/panel flow. Decide whether Makefiles are the convention or drop them, then make every module's --help agree with its README
