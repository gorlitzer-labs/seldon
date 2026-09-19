# One run, end to end

A single agnostic task threaded through all six tools — the same **Weather CLI**
project (agents `ana` / `ben`) the [seldon-stack](apps/seldon-stack)
teardown uses. Nothing here touches a real product.

## The task

> "Add a `--units` flag to the Weather CLI (metric / imperial) and ship it."

## The flow

1. **apiary — the task lands in a room.** You (or a schedule) post the task into
   an apiary room. Agents `ana` and `ben` are in the room; `ana` claims it, `ben`
   takes review. Everything they say is in the shared log — no hidden state.

2. **factory — a boxed agent picks it up.** `factory` sees the claim and spins
   `ana` in a **box** (a container: agent runs permissions-skipped inside, the
   host stays sealed). `factory board` shows the run live.

3. **foundation — the workflow gives it shape.** Inside the box, `ana` follows
   foundation's deterministic path: plan the flag, gate the plan, build, verify.
   No freestyling straight into edits.

4. **comb — secrets arrive by name.** The build needs the weather API key. It's
   never in the repo or the prompt — `comb run --with WEATHER_API_KEY -- npm test`
   injects it for the run and the transcript audit stays clean.

5. **bifrost — it runs where the capacity is.** The box runs on whichever machine
   on the tailnet has room; the tmux session survives disconnects. You watch the
   agent-state glyph go ◐ (working). From your phone on the couch, you attach and
   read `ben`'s review comments in the room.

6. **Demerzel — you check in by voice.** "How's the units flag going?" Demerzel,
   fully local, reads you the room status. `ana` hits the one pivotal call —
   *imperial default or metric?* — and **factory wakes you** (■ needs-you). You
   answer by voice; the box resumes.

7. **Ship.** `ben` approves in the room, the QA gate is asserted, the PR merges,
   the deploy is watched to prod. Factory marks the task done and goes quiet
   until the next pivotal call.

## What each part guaranteed

| step | tool | the guarantee |
|---|---|---|
| shared, auditable coordination | apiary | no hidden agent state |
| isolation without babysitting | factory | boxed work, sealed host |
| a repeatable path | foundation | plan-gated, verified build |
| no leaked keys | comb | secrets by reference + audit |
| runs anywhere, survives drops | bifrost | multi-machine + phone |
| you, only when it matters | Demerzel + factory | voice check-in, wake on pivotal |
