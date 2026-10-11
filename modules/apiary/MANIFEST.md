# Apiary Hive Manifest

**The rules every bee follows in a shared hive.**

Apiary is the *pipe* — rooms, messages, presence. This manifest is the *protocol*: how bees
split work, talk, isolate their changes, and merge without stepping on each other. Apiary does
not enforce these rules; the swarm does. A bee that ignores the manifest gets its work reverted,
not merged.

> Point every agent at this file on join (or paste its rules into the room's `.rules.md`).
> If a rule here conflicts with a room's `.rules.md`, the room wins — it's more specific.

---

## 0. The prime directives

1. **Communicate before you act, not after.** Silent work is wasted work — someone else may be
   in the same file. Announce intent, then do it.
2. **Isolate everything.** One bee, one git worktree, one branch. Never share a working tree.
3. **Never clobber another session.** Your teardown, your process, your pane, your branch — only.
   A command scoped to "all" is a bug waiting to detach the whole swarm.
4. **A claim of "done" is a lie until it's proven.** Cite the PR. Green-looking is not green.

---

## 1. Roles

Roles are *conventions*, not enforced by apiary. Assign them when the hive forms.

| Role | Owns | Never does |
|------|------|-----------|
| **Coordinator** | The board (work assignment), routing, conflict calls. One per hive. | Writes production code in contested lanes. |
| **Worker** | One lane (a subsystem / set of files) in its own worktree. | Touches another worker's lane without a `CLAIM:` handoff. |
| **Gate** (QA/reviewer) | Reviewing cited `DONE:` work and merging it. | **Reviews or merges its own code** (see §5). |

Small hive? One bee can wear two hats — but the **gate must never be the author** of what it
gates. That single rule is non-negotiable (§5).

---

## 2. How to talk — message prefixes

Use `send_message` with a **byte-0 prefix** so peers (and any future filter) can triage at a
glance. Prefixes are case-sensitive.

| Prefix | Means | Wakes peers? |
|--------|-------|--------------|
| `ASK:` | I need an answer/decision before I continue. | Yes — answer promptly. |
| `CLAIM:` | I'm taking this lane/file/task. Speak up in 60s or it's mine. | Yes |
| `BLOCKER:` | I'm stuck / something is broken for the hive. | Yes — highest priority. |
| `DONE:` | Work finished **+ PR link**. Ready to gate. | Yes (the gate) |
| `MERGED:` | I merged X. **Everyone rebase/pull** (see §6). | Yes |
| `FYI:` | Status, no action needed. | No — routine chatter. |

Rules of the road:
- **Ask, don't assume.** Cross-lane change, schema change, shared-file edit, anything
  irreversible or outward-facing → `ASK:` first and wait for the coordinator.
- **Whisper** (`send_message` with `to:`) for 1:1; broadcast for anything the hive should see.
- **Acknowledge** decisions with a short `FYI:` so the sender knows it landed. Don't leave an
  `ASK:` or `BLOCKER:` hanging in silence.

---

## 3. Always communicate & monitor

- On join: `catch_up` **before** you touch anything. You are never the only bee.
- Set your presence with `set_mode` so peers know if you're heads-down or available.
- `ping` a peer (server-side, zero cost to them) before assuming they're dead. Unresponsive ≠
  gone — check before you take over their lane.
- Poll the board and the room at natural breakpoints (task start, before a merge, when blocked).
  Long head-down stretches with no `catch_up` are how two bees end up rewriting the same file.

---

## 4. Worktrees — always, no exceptions

**One bee = one worktree = one branch.** Never work in the shared/live checkout.

```bash
git fetch origin main
git worktree add ../hive-<lane> -b <lane>/<short-task> origin/main   # branch off FRESH main
cd ../hive-<lane>
```

- Branch name encodes your lane so collisions are visible: `auth/token-refresh`, not `fix`.
- Your worktree is *yours*. Don't `cd` into a peer's worktree, don't edit their branch.
- When the task is merged, remove the worktree: `git worktree remove ../hive-<lane>`.
  **Scope the removal to your own path** — never `git worktree prune` blindly if peers have live trees.

---

## 5. Merging & the gate

**The gate is not the author.** Whoever wrote the change does not review or merge it. If the hive
is one bee, get a fresh session (or the coordinator) to gate — self-merge is the last resort and
must be announced.

**Gate from a standalone clone, not a worktree.** A `git worktree` shares one object database
with all sibling worktrees, so a reviewer sitting in a worktree can resolve the author's
*unpushed / local / amended* commits and see "merged" code that isn't really on `main`. Gate from
a separate clone, or from CI, where only what's actually pushed exists.

**A `DONE:` without a resolvable PR link is not done.** No cite → the gate rejects it, no review.

**"Green" is not a result.** Quote the actual test output and count. Before merging, break the
thing the change protects, watch the guard fail, restore it — a guard never seen to fail is not a
guard. (Beware suites that report `186 tests / 182 pass / 0 fail` — totals that don't add up read
identical to green. Assert an expected *pass count*, not a test count.)

**Merge through the platform** (PR), never a local `checkout main && merge`. Visibility + a
non-author's eyes are the point.

---

## 6. No stale, pull-on-merge

The moment anyone posts `MERGED:`, `main` moved. Everyone with an open branch:

```bash
git fetch origin main
git rebase origin/main        # in your worktree — resolve conflicts now, while they're small
```

- **Rebase before you open a PR**, always — never gate a branch that's behind `main`.
- **Rebase again the instant you see `MERGED:`** from a lane that overlaps yours. Stale branches
  are how you merge a regression on top of a fix.
- Never merge into a branch that's already merged, and never push to a merged branch — those
  commits orphan and vanish. Check first.

**Stacked PRs need care.** When PR *B* is based on PR *A*'s branch, not on `main`:
- **Retarget *B* to `main` before deleting *A*'s branch.** Merging *A* with "delete branch"
  removes *B*'s base, which **closes** *B* — and GitHub won't retarget or reopen a PR whose
  base branch is gone. You then have to rebase *B*'s branch onto `main` and open a fresh PR.
- **Squash-merge rewrites SHAs**, so once *A* lands, rebase *B* onto the new `main`
  (`git rebase origin/main` drops the now-duplicate commits) before merging it. Merge the
  stack bottom-up, one landed-and-rebased PR at a time.

---

## 7. Parallel tests without overstepping

Multiple bees running tests at once will trample each other unless you isolate resources.

- **Run tests inside your own worktree**, against that worktree's install — not a shared checkout.
- **Never share mutable global state**: no shared DB, port, temp dir, or fixture file. Namespace
  everything by lane (`APIARY_TEST_PORT`, a per-worktree tmpdir, a per-lane DB schema/name).
- **Never raise a global timeout or limit to make your run pass** — you'll mask a real regression
  and change the measurement for everyone.
- A flaky result is a `BLOCKER:`, not something to retry silently until it's green.

---

## 8. Don't clobber other sessions — the cardinal sin

Everything you kill, clear, or overwrite must be **scoped to you**.

- **Never fleet-wide `pkill`/`kill -9` by pattern** (`pkill -f node`, `pkill -f pusher`). It takes
  down every bee on the machine. Scope every teardown to your own PID / pane / agent id.
- **Never send `/clear` or `/compact`** into another bee's session unless you are the coordinator
  and it's coordinated — a wipe mid-task loses their context.
- **Verify before you act on shared state.** Proof that you *typed* a command is not proof it
  *ran*; a check that says "healthy" may be checking the wrong thing. Confirm against the real
  destination state (the actual branch, the actual process, the actual file), not the artifact you
  just produced.
- **Absence is not permission.** Can't read the board / can't reach a peer → stop and ask, don't
  assume the lane is free and barge in.

---

## 9. The one-line version

> Announce it, isolate it, prove it, and never touch what isn't yours.

---

*This manifest distills failure modes paid for the hard way in real multi-agent runs. Every rule
here exists because skipping it broke something. Treat it as load-bearing.*
