# The AI Agentic Factory 🏭

> The suite of tools to **create · manage · maintain** a software factory of AI agents that runs
> **24/7** under **supervised autonomy**. See [`THE-AGENTIC-FACTORY.md`](../THE-AGENTIC-FACTORY.md)
> for the full blueprint.

`factory` is the umbrella CLI — the **front door, the 24/7 supervisor, and the control panel** that
tie the subsystems into one product.

## The stack (subsystems)

The Factory assembles four subsystems (each its own repo/layer):

| Subsystem | Repo | Layer |
|---|---|---|
| **apiary** | [`gorlitzer-labs/apiary`](https://github.com/gorlitzer-labs/apiary) | transport — shared rooms/hives for agents |
| **Hive Manifest** | `apiary/MANIFEST.md` | protocol — how agents behave (lanes, no-clobber, merge gate) |
| **Foundation** | [`gorlitzer-labs/foundation`](https://github.com/gorlitzer-labs/foundation) | substrate — the four-file seam + deterministic spine |
| **coord roles** | Claude Code skills + `agent-coord` MCP | orchestration — coordinator / worker / QA / CI / liaison |

`factory` requires `apiary` and `foundation` on PATH (or reachable via `npx github:gorlitzer-labs/...`).

## Commands

```
factory new "<idea>"          create a line: repo · Foundation · plan · hive
factory watch <project>       supervise one hive (24/7)   ·   watch --all  supervise every hive
factory board                 live control panel + decisions pending your call
factory decide <id> "<call>"  answer a pending decision (reaches the agents)
factory briefing              the accumulating morning briefing
factory ls                    list every hive the factory knows
```

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

## `factory watch` — the 24/7 supervisor (Phase 2)

A standalone daemon (independent of any session) that keeps one hive alive + productive:

```bash
factory watch <project> --agents Aria,Bruno   # heal dead agents · run doctor · detect stalls ·
                                              # nudge idle agents · post an escalation digest
factory watch --all                           # one supervisor over EVERY registered hive
factory ls                                    # list all hives the factory knows
```

Flags: `--interval 30` · `--stall 15` · `--digest 60` · `--once` (single tick, for cron). It
**escalates** (blockers, drift, stalls) to you via the hive + `.factory/digest.log` — it never
decides the irreversible.

## `factory board` — the control panel (Phase 3)

```bash
factory board            # live dashboard of every hive: queue, lanes, done, facts, drift, blockers
factory board --once     # one snapshot
```

Read straight from the Foundation seam (no room-join noise). Highlights what needs you.

## Escalation + alerting (Phase 4) — the supervised-autonomy loop

The factory reaches *you*, off-screen, and you answer without babysitting it:

```bash
# an agent, when it hits a call it shouldn't make alone, posts into the hive:
#   DECISION: Postgres or SQLite for storage? ...
# the supervisor catches it → macOS notification + morning briefing + the board flags it:

factory board                       # ⚑ 1 DECISION(S) PENDING YOUR CALL   d-20df46 [inv] Aria: ...
factory decide d-20df46 "SQLite"    # posts your call back to the hive; the agent unblocks
factory briefing                    # the accumulating ~/.factory/briefing.md you read at 8am
```

`DECISION:` and `BLOCKER:` messages become pending decisions; alerts fire on macOS (`osascript`).
The factory escalates — it never decides the irreversible.

## Roadmap

- **Phase 1 — Front Door** (`factory new`) ✅
- **Phase 2 — Supervisor** (`factory watch`) ✅
- **Phase 3 — Control Panel** (`factory board`) ✅
- **Phase 4 — Escalation + alerting** (`decide` / `briefing`, macOS alerts) ✅
- **Phase 5 — multi-hive** (`watch --all`, `ls`) ✅ · **monitored delivery** (merge → deploy →
  observed-in-prod) — designed; needs a per-project deploy adapter, so it lands when wired to a real
  target.

Supervised autonomy: the factory builds around the clock; you decide the irreversible calls.
