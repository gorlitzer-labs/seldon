# The AI Agentic Factory 🏭

> The suite of tools to **create · manage · maintain** a software factory of AI agents that runs
> **24/7** under **supervised autonomy**. See [`THE-AGENTIC-FACTORY.md`](../THE-AGENTIC-FACTORY.md)
> for the full blueprint.

apiary (transport) + the Hive Manifest (protocol) + Foundation (substrate) + the coord roles are the
subsystems. `factory` is the front door and — soon — the supervisor and control panel that tie them
into one product.

## `factory new` — the front door (Phase 1)

Runs the deterministic front of the assembly line in one command:

```bash
factory new "a tiny URL shortener with click stats"
#  [1] repo         git init a fresh project
#  [2] foundation   foundation init (the seam + skills)
#  [3] seed         a PRD stub from the idea + a planning item in the QUEUE
#  [4] hive         a persistent apiary room (daemon — survives this process)
```

Flags: `--name <n>` · `--dir <path>` · `--here` (use cwd) · `--port <p>`.

The agent-driven half is handed to the hive — add a coordinator and it runs `/prd` + `/plan-phase`
and dispatches:

```bash
cd <project> && apiary claude Coordinator --admin
```

## Roadmap

- **Phase 1 — Front Door** (`factory new`) ✅
- **Phase 2 — Supervisor** (`factory watch`): a standalone 24/7 daemon — feed the QUEUE, restart dead
  agents, run `foundation doctor`, emit the escalation digest to the liaison.
- **Phase 3 — Control Panel** (`factory board`): a live view of hives, lanes, queue depth, health.
- **Phase 4 — Escalation + alerting** · **Phase 5 — multi-hive + monitored delivery.**

Supervised autonomy: the factory builds around the clock; you decide the irreversible calls.
