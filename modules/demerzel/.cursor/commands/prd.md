# /prd

One discovery interview → docs/PRD.md. The anchor kickstart consumes without re-asking. Has a --lite mode for small projects.

# prd `<product idea>` `[--lite]`

The single discovery pass. Everything downstream (`/kickstart`, `/plan-phase`) reads this and must
**not** re-interview. Interview the user — don't invent answers.

**Full mode** — six stages:
1. **Problem** — who hurts, how much, why now.
2. **Vision & goals** — the outcome; measurable goals; **explicit non-goals** (what we won't do).
3. **User requirements** — personas + stories, MoSCoW (Must/Should/Could/Won't).
4. **Functional** — features with **testable acceptance criteria** ("returns 200 with the row", not "works").
5. **Non-functional** — perf ("<200ms p95", not "fast"), security, scale — as numbers.
6. **Risks & phases** — top risks + the phase breakdown scope will derive from.

**`--lite` mode** (weekend/throwaway): problem, goals, non-goals, phases. Skip MoSCoW + risk matrix.

Pin any overloaded terms as you go and hand them to `/glossary`. Write `docs/PRD.md`. The quality bar
is *testable* — if a requirement can't fail a test, sharpen it. Stop when kickstart could scaffold
from it without asking you anything.
