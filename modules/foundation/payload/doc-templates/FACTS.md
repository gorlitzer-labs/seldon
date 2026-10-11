# Facts

Settled, verified world-state — the antidote to agents re-deriving stale claims. A claim is a
**hypothesis until it carries a `verified:` line**, and the *tool* stamps the time (agents never do).
Grammar (ASCII `label: value` anchors — no em-dash, no middot):

    - `kebab-id`: <claim>
        verified: <YYYY-MM-DDTHH:MMZ>  by: <who>  method: <how>

Ids are kebab-case and unique (replace, never duplicate). Re-verify within **14 days** or
`foundation doctor` flags it stale. Use `foundation fact <id> "<claim>" --verify "<cmd>"` — the fact
is written only if the check passes.

## Facts
