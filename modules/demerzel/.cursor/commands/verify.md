# /verify

The QA gate before a task is marked done. Light by default, escalates on risk. Records the result as a verified fact — a claim is a hypothesis until it passes.

# verify `<task or change>`

Foundation's missing-in-groundwork gate: nothing gets marked done on a green *look*. Scale the gate
to the risk — never skip it, never over-ceremony a docs tweak.

**Default (most changes):**
1. **Typecheck + full test suite** — quote the actual output and the pass count. "Green" is not a
   result; `186 tests / 182 pass / 0 fail` is a red flag (totals that don't add up).
2. **Independent behavior check** — exercise the changed path yourself (a request, a query, a fresh
   log line). Verify against the *destination state*, not the artifact you just produced.

**Escalate (money / high-risk / data / auth / a changed number):**
3. **Isolated worktree**, fresh install — not the live tree.
4. **Named mutation-kill** — break the thing the change protects, watch the guard/test fail, restore
   it. A guard never seen to fail is not a guard.
5. **Prod before/after** for any changed number (rows *and* query time) — never raise a timeout to
   make it pass.

**On pass, record it:** `foundation fact <id> "<claim>" --verify "<the exact command you ran>"` — the
fact is written only if the command passes, and the tool stamps when/who. Then, and only then, is the
task eligible for `foundation done` (with its PR ref).

**On fail:** it's a `BLOCKER:` to surface, not a retry-until-green. Say what failed, with the output.
