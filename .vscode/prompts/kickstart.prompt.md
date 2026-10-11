---
mode: agent
description: Scaffold a project from a PRD (or a one-line idea) — install Foundation, pin the stack, derive phases, seed phase 1. Run once, by the product-context holder.
---

# kickstart `<idea, or "from PRD">`

Turn intent into a working Foundation project. **Single-writer** — the coordinator / product-context
holder runs this; never two agents scaffolding one repo in parallel.

1. **Get the PRD.** If `docs/PRD.md` exists, read it and do **not** re-ask what it answers. If not,
   run `/prd` first (or, for a throwaway, capture problem + goals + non-goals + phases inline).
2. **Install the substrate.** Run `foundation init` — this drops the seam
   (QUEUE/WORKSTREAMS/DONE/FACTS), the docs (STACK_MAP, DECISIONS, CONTEXT), and the skills. Never
   clobbers existing docs.
3. **Pin the stack.** Discover the tech stack per layer with the user; write it into `docs/STACK_MAP.md`
   — the single source of truth for versions. No version number lives anywhere else. Run
   `foundation versions` to fill the latest-stable column.
4. **Pin vocabulary.** Run `/glossary` for any overloaded/ambiguous terms → `docs/CONTEXT.md`.
5. **Derive phases** from the PRD scope (not invented) and write the high-level list into
   `docs/PRODUCTION_ROADMAP.md` (or a short `## Roadmap` in `_INDEX.md`).
6. **Seed phase 1.** Run `/plan-phase 1 <name>` to produce the first task set + queue items.
7. **Log the shape.** Any hard-to-reverse setup choice (runtime, DB, auth) → `/decision`.

Stop when the project can be planned and worked. Keep it lean — no fabricated line-count / coverage
"stats". Report the output files and the suggested next command (`/plan-phase` or `/orient`).
