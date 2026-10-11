# decision

> Record an ADR — but only if it clears the 3-of-3 gate. Allocates the number via the spine; you fill the prose. Immutable — supersede, never edit.

# decision `<title>`

ADRs are for decisions your future self (or another agent) will re-litigate without the context.
Keep the log signal-dense.

1. **Gate — log ONLY if all three hold:**
   - **Hard to reverse** (schema, public API, data model, a dependency you'd have to rip out), **and**
   - **Surprising without context** (someone would reasonably do otherwise), **and**
   - **A real trade-off was closed** (you rejected a viable alternative).
   If any fails, don't log it — say why and stop.
2. **Allocate.** Run `foundation decision "<title>"` — it assigns the next `ADR-NNNN`, inserts the
   index row, and writes a stub. Never hand-number (off-by-one / missed index row).
3. **Fill the stub** in `docs/DECISIONS.md`: **Context** (the forces) · **Decision** (what you chose) ·
   **Consequences** (trade-offs accepted) · **Alternatives considered** (rejected options + why — this
   is what the `doctor` reversal tripwire reads).
4. **Set Status** to Accepted (or Proposed if pending a call).

To change a decision later: add a new ADR that **supersedes** the old one. Never edit an accepted ADR
in place — the tripwire and everyone's memory depend on it staying put.
