# seldon

**The Seldon stack** — a software factory of AI agents that runs the plan and
wakes you only for the pivotal calls.

It isn't one program. It's a **stack of parts you choose from**: six independent
tools that compose, plus an interactive teardown that teaches the whole thing.
Take one, take all six — each stands alone, and they're better together.

This repo is the **front door**: what the stack is, how the parts fit, one real
run end to end, and where each piece lives. The code stays in its own repo per
module (independent CI and releases); this is the map, not the monolith.

## The six tools

| # | module | role | one line | repo |
|---|---|---|---|---|
| 01 | **apiary** | the conversation | shared rooms where AI agents talk, coordinate, hand off | [modules/apiary](modules/apiary) |
| 02 | **foundation** | the seam | the deterministic project workflow beneath it all | [modules/foundation](modules/foundation) |
| 03 | **comb** | the vault | keys by name; a transcript leak audit; multi-machine secrets (SOPS + age) | [modules/comb](modules/comb) |
| 04 | **factory** | the floor | the 24/7 supervisor — `new · watch · board · box · realms` | [modules/factory](modules/factory) |
| 05 | **bifrost** | the bridge | tmux + Tailscale; sessions survive; phone access; agent state | [modules/bifrost](modules/bifrost) |
| 06 | **Demerzel** | the voice | a fully-local voice you talk to | [modules/demerzel](modules/demerzel) |

**The tour:** [apps/seldon-stack](apps/seldon-stack)
— an interactive, `anatomy`-class 3D teardown. Fly through the hive; each cell
opens the module's real TUI with real captured workflows and guided narration.

## Install

One installer, a checklist, install only what you use:

```bash
pnpm add -g @gorlitzer-labs/seldon     # or: bun add -g …  ·  npm i -g …
seldon                                 # ↑↓ move · space pick · a all · enter install
# or name them:  seldon install foundation comb
# check deps:    seldon doctor         (tmux · sops · age · tailscale · python)
# remove:        seldon uninstall --all
```

Node tools install with pnpm (else npm; `--pm=bun` to opt in). **demerzel** (voice,
macOS/Apple-silicon) installs into its **own isolated CPython 3.12 venv** via `uv`
— your system Python is never touched.

## Quickstart — a real first run

A genuine session (real commands, real output) bootstrapping a throwaway
**Weather CLI**. Start with the two tools you'll use on day one — the seam
(**foundation**) and the vault (**comb**):

```console
$ seldon install foundation comb
▸ foundation — the seam
  ✓ foundation installed
▸ comb — the vault
  ✓ comb installed

$ cd ~/code/weather-cli && foundation init
✓ Foundation installed → ~/code/weather-cli
  docs:   8 created, 0 kept  (seam: QUEUE · WORKSTREAMS · DONE · FACTS)
  skills: 9 → .claude/skills/  (+ 27 harness mirrors: cursor · copilot · codex)
  next:   /kickstart <idea>   ·   foundation status   ·   foundation doctor
```

Record work on the seam — every mutation is atomic and ASCII-validated:

```console
$ foundation queue "(P1) add a --units flag (°C/°F)"
✓ queued (P1) add a --units flag (°C/°F)

$ foundation stream weather-cli working "scaffolding the CLI"
✓ stream weather-cli → working (scaffolding the CLI)

$ foundation fact runtime-node "node is the runtime" --verify "node --version"
· verifying: node --version
v22.23.1
✓ fact `runtime-node` verified 2026-09-20T16:28Z by you        # a fact is only recorded if its check passes

$ foundation status
next  (P1) add a --units flag (°C/°F)
streams  weather-cli:working
```

Keep the API key out of code, prompts, and shell history — reference it by name:

```console
$ comb set WEATHER_API_KEY              # prompts for the value, never echoes it
$ comb ls                               # names, age, notes — never values
  name                 updated      note
  WEATHER_API_KEY      2026-09-20   https://…

$ comb run --with WEATHER_API_KEY -- npm test    # injected only for this command
```

That's a solo agent's whole footing: a plan-gated workflow + secrets by
reference. Scale up when you need to:

```bash
seldon install apiary factory          # a room of agents + the 24/7 supervisor
seldon install bifrost                 # run across machines / attach from your phone
factory new "add a --units flag to the weather CLI"   # repo → foundation → apiary hive
```

The full multi-tool run (boxed agents, bifrost, voice check-in, wake-on-pivotal)
is walked through in **[docs/end-to-end.md](docs/end-to-end.md)**.

## How the parts fit

```mermaid
flowchart TD
    you([You]) -->|check in by voice| demerzel[Demerzel · the voice]
    you -->|check in from phone| bifrost[bifrost · the bridge]
    factory[factory · the floor<br/>24/7 supervisor] -->|spins boxed agents| agents{{AI agents}}
    agents -->|talk / hand off| apiary[apiary · the conversation]
    agents -->|follow the workflow| foundation[foundation · the seam]
    agents -->|keys by name| comb[comb · the vault]
    factory -->|runs across machines| bifrost
    bifrost -->|sessions survive| agents
    factory -->|wakes you only for<br/>the pivotal call| you
    demerzel -.-> factory
    bifrost -.-> apiary
```

Pick what you need: run agents in one **apiary** room and nothing else, or let
**factory** supervise boxed agents across machines over **bifrost**, pulling
secrets from **comb**, following **foundation**'s workflow, while you check in by
**Demerzel**'s voice or from your phone. See
[docs/end-to-end.md](docs/end-to-end.md) for one real run through all of it.

## Start here

- **New to the stack?** → [ONBOARDING.md](ONBOARDING.md)
- **See it, don't read it** → the [seldon-stack](apps/seldon-stack) teardown
- **How one run flows through every part** → [docs/end-to-end.md](docs/end-to-end.md)
- **Each tool** → its repo (table above); every one has its own README + ONBOARDING

## Conventions across the stack

- **Secrets by reference.** Keys never live in code, transcripts, or a command
  line — they go through `comb run --with NAME -- <cmd>`.
- **Agnostic examples.** Docs and demos use a throwaway **Weather CLI** project
  with agents `ana` / `ben` — never a real product or customer data.
- **Independent releases.** Each module ships on its own; this repo pins nothing.
