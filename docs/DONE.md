# Done

Append-only completion log. **Writer:** the executor that finished. Every entry **must cite a PR or
commit ref** — `foundation done` refuses one without it. Grammar (ASCII):

    - [x] <task> [owner/repo#N] [YYYY-MM-DD]

`## Done` is the last section so appends are lock-free (single O_APPEND write). Do not add sections
below it.

## Done
