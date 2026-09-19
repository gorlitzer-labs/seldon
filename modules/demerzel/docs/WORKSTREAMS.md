# Workstreams
<!-- foundation:schema workstreams.v1 -->

Live in-flight state — one row per lane. **Each lane owner edits only its own row** (the filesystem
boundary is the concurrency control; no locks). Use `foundation stream <id> <status> [note]`.

Status vocabulary: `active` · `blocked` · `review` · `done`. Keep it ASCII.

| Stream | Owner | Branch/Worktree | Status | Blocker | Last note |
|--------|-------|-----------------|--------|---------|-----------|
