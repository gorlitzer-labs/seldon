# intake

> Onboard an EXISTING repo — reverse-engineer PRD / CONTEXT / STACK_MAP from the codebase, so "bolt onto any repo" is real, not greenfield-only.

# intake `[area]`

Foundation's other missing-in-groundwork path: everything else assumes greenfield. This makes an
existing codebase legible without pretending it started from a PRD.

1. **Install the substrate.** Run `foundation init` — it won't clobber anything you already have.
2. **Pin the real stack.** Read the manifests (package.json / pyproject / Cargo.toml / go.mod), record
   *actual* pinned versions into `docs/STACK_MAP.md`, then `foundation versions` for latest-stable.
   Versions come from the files, never from memory.
3. **Infer the domain glossary.** Skim the core modules/models for the nouns the code already uses;
   draft `docs/CONTEXT.md` from the real vocabulary (flag terms used two ways). Confirm with the user.
4. **Draft a PRD from what exists.** Reverse the shipped behavior into `docs/PRD.md` — problem it
   solves, the features present, the obvious non-goals. Mark inferred sections as `_inferred — confirm_`.
5. **Seed live state.** Put current in-flight work into `WORKSTREAMS.md` (one row per active effort)
   and anything obviously pending into `QUEUE.md`.
6. **Record ground truths.** The load-bearing facts you verified while reading (services that exist,
   flags that are on) → `foundation fact <id> "<claim>" --verify "<cmd>"`.

Bias to **inferred, then confirm** — never assert a reverse-engineered claim as settled without a
check. Stop when a new agent could `/orient` and start working.
