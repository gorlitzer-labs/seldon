# /glossary

Pin the ubiquitous language — one canonical term per concept — before it propagates into schema and UI as contradictions. Writes docs/CONTEXT.md.

# glossary `[term or area]`

Cheap, high-leverage. Vocabulary that drifts becomes contradictory field names, API shapes, and UI
copy that never quite agree. Pin it once.

1. **Surface the overloaded terms** — words used for two things, or two words for one thing (from the
   PRD, the code, or the user's description).
2. **Sharpen each** — challenge it against real scenarios until one meaning wins. Pick **one canonical
   term per concept**.
3. **Write `docs/CONTEXT.md` → `## Glossary`.** Each entry: the term, its precise meaning, and
   `_Avoid_:` the rejected synonyms (so nobody reintroduces them).
4. **Two depths** — a quick key-terms pass during `/prd`, or a full bounded-context pass for a larger
   domain (add a `## Contexts` section mapping which terms belong to which context).

Only the product-context holder runs the full pass; a narrow worker doesn't redefine the domain. Keep
it tight — a glossary nobody reads is worse than none.
