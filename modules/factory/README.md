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

## `factory box` — run an agent with permissions skipped, safely

Agents get their permissions skipped, because one that stops to ask cannot work a
shift. On the host that hands it `~/.ssh`, `~/.aws`, the `gh` token, both AI logins
and every repo on the machine. That it has not gone wrong yet is luck, not design.

`factory box` moves the bypass somewhere it cannot cost much. The agent still runs
fully unrestricted — that is the point — but "unrestricted" now means one mounted
repo and nothing else.

```bash
factory box ~/Desktop/stranded --agent codex    # codex, permissions skipped, in a box
factory box ~/Desktop/stranded --agent claude   # same for Claude Code
factory box ~/Desktop/stranded                  # just a shell in the box
factory box doctor ~/Desktop/stranded           # try to read your secrets from inside
```

**Authentication happens once.** The box keeps its own home in a docker volume
(`factory-agentbox-home`), so you sign in *inside* the box the first time and the
tokens are still there next run, next week, next reboot. That home is not your
`~/.codex` or `~/.claude` — it is the fleet's own identity, which is what lets the
box be both credentialed and sealed. Revoking it is
`docker volume rm factory-agentbox-home`, and it leaves your own logins untouched.

| flag | what it does |
|---|---|
| `--agent claude\|codex` | launch that harness with its own permission bypass |
| `--fresh` | throwaway home — forces a login, useful for testing |
| `--creds` | mount *your* credential for that agent instead of the fleet's (the unsafe shortcut) |
| `--with A,B` | hand those secrets to the agent via [comb](https://github.com/gorlitzer-labs/comb) |
| `--memory` / `--cpus` | ceilings, default 4g / 2 |
| `--no-net` | cut the network entirely |

Every run drops all capabilities, forbids privilege escalation, and caps memory,
CPU and process count, so a runaway agent hits a wall instead of the laptop.

**The walls are tested, not asserted.** `factory box doctor` goes into the box and
tries to read each host secret at its real path, then reports what it reached:

```
📦 box doctor
   sealed    .ssh
   sealed    .aws
   sealed    .config/gh
   sealed    .codex
   sealed    .claude
   work mount OK

   every host secret is sealed off from the box
```

Harness-agnostic on purpose: adding a new agent is one entry in `HARNESSES` and a
line in the Dockerfile. Nothing else in the box knows which CLI is running.

### Secrets

```bash
factory box ~/Desktop/stranded --agent codex --with CF_API_TOKEN,GITHUB_TOKEN
```

The value never reaches a command line. `factory` does not learn it either: it
builds the docker command with `-e NAME` — no `=`, which tells docker to take the
variable from *its own* environment — and then runs that command through
`comb run`, which is what puts it there. So the secret exists in exactly two
places, comb's memory and the container, and in neither argv, shell history, nor
factory itself.

Verified by watching `ps auxww` while a box runs with a secret: present inside
the container, absent from every process command line on the machine, including
docker's own.

That is the point of the pair. A boxed agent gets the credential it needs at the
moment it needs it, and the credential is never in the image, never in the
volume, and never in a transcript.

**What it does not do.** An agent must hold *some* model credential to work, and a
box cannot hide the credential it is using. What it hides is the other five. If the
fleet's token is ever abused, you revoke one volume rather than rotating your whole
machine.

## `factory realms` — reach hives on other machines (via bifrost)

factory does not keep its own list of machines. It reads **bifrost's** realm
registry (`~/.config/bifrost/realms/`), so "what machines exist" has one source
of truth: bifrost.

```bash
factory realms          # the machines factory can reach, with reachability
```

A hive registered with a `realm` has its host-coupled supervision — is the
agent's tmux session alive, respawn it if not — run **over ssh to that realm**
instead of locally. Everything else already works across the tailnet unchanged,
because a hive URL is just an address: a respawned agent on a realm joins the
same room as a local one.

The ssh is batch-mode with a short connect timeout, so a supervisor tick can
never hang on a dead realm. Realm names are validated to a strict charset before
they become an ssh target, so a crafted name cannot smuggle an option or a path.

## Roadmap

- **Phase 1 — Front Door** (`factory new`) ✅
- **Phase 2 — Supervisor** (`factory watch`) ✅
- **Phase 3 — Control Panel** (`factory board`) ✅
- **Phase 4 — Escalation + alerting** (`decide` / `briefing`, macOS alerts) ✅
- **Phase 5 — multi-hive** (`watch --all`, `ls`) ✅ · **monitored delivery** (merge → deploy →
  observed-in-prod) — designed; needs a per-project deploy adapter, so it lands when wired to a real
  target.

Supervised autonomy: the factory builds around the clock; you decide the irreversible calls.
