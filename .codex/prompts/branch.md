# branch

> Create your lane's worktree + branch off fresh main, or open the PR when done. The git moves the workflow describes but nothing else automates.

# branch `<lane>` `[open-pr]`

Foundation records branch + worktree per lane; this skill actually *makes* them, following the Hive
Manifest's isolation rules.

**Start a lane:**
```bash
git fetch origin main
git worktree add ../<repo>-<lane> -b <lane>/<short-task> origin/main   # off FRESH main, always
```
- Branch name encodes the lane so collisions are visible (`auth/token-refresh`, not `fix`).
- Register it: `foundation stream <lane> active "<what you're doing>" --branch <lane>/<short-task>`.
- Your worktree is yours — never `cd` into a peer's, never edit their branch.

**Finish a lane (`open-pr`):**
```bash
git fetch origin main && git rebase origin/main    # never open a PR behind main
gh pr create --fill
```
- The gate is **not** the author — hand the PR to `/verify` (a fresh session / the coordinator).
- Gate from a standalone clone or CI, not a sibling worktree (worktrees share one object DB and can
  "see" unpushed commits).
- On merge, cite the PR: `foundation done "<task>" <owner/repo#N>`. Then
  `git worktree remove ../<repo>-<lane>` (scope removal to your own path).

**Never:** fleet-wide `pkill`, pushing to a merged branch, or merging a branch that's behind main.
