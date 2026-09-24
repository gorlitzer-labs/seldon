---
mode: agent
description: Where am I / what's next — lane-aware. The daily driver. Reads computed status + the seam and recommends one action. Read-only.
---

# orient `[my lane]`

The one command you run to get your bearings. **Read-only** — never mutates state.

1. **Computed truth first.** Run `foundation status` — phase progress (counted, never guessed) + the
   next `QUEUE` item + active streams.
2. **Your lane.** If a lane is given (or you have a room/branch assignment), filter `WORKSTREAMS.md`
   to **your** row — your branch/worktree, your status, your blocker. Don't dump the whole board; a
   worker needs *its* lane, not everyone's.
3. **Recent context.** Skim `docs/DECISIONS.md` (last few ADRs + any `Proposed`), the active phase
   task doc, and `docs/CONTEXT.md` for the terms in play.
4. **Recommend one action.** Emit a tight block:
   - **Where you are** — phase, % done, your lane's status
   - **Next step** — the single most useful thing to do now (claim the queue item / resume your task /
     unblock / `/verify` before `foundation done`)
   - **Also worth** — at most one secondary suggestion

If nothing is assigned and the queue is empty, say so plainly and suggest `/plan-phase`. Don't invent
work.
