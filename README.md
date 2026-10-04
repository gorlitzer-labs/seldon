# seldon

**One screen for every coding agent you run — Claude Code, Codex, opencode — on every
project, on every machine.** What is working, what needs you, and what is next on the plan.
It wakes you only when an agent is waiting on you.

> 🚧 **Actively under development.** Interfaces and defaults still move between releases.
> Issues and feedback welcome.

```text
  SELDON   1 need you · 3 working · 1 idle   ● watcher
  machines: mini
  held: emulator → stranded/fix-save-crash 4m

  ❯ stranded               plan 5 · 2 done
      ⚑ fix-save-crash             claude    needs you: permission prompt             2m
      ● smoke-harness              codex     working                                  40m
    weather @mini          plan 2 · 0 done
      ● add-cache                  opencode  working                                  12m
      ○ docs-pass                  claude    idle                                     1h

  ↑↓ move · ⏎ open · x stop · R resume · n new lane · p plan · r refresh · q quit
```

## Install

```bash
npm i -g @gorlitzer-labs/seldon
seldon
```

You need Node 20+, git, tmux, and at least one agent CLI (`claude`, `codex` or `opencode`).
Nothing else. The rest of this repo is optional add-ons (below).

## How you use it

| key | does |
|---|---|
| `n` | **new lane**: type a task, pick claude / codex / opencode. It runs on its own branch, in its own worktree |
| `p` | the project's **plan** (`docs/QUEUE.md`): `⏎` starts a lane on an item, `a` adds one |
| `⏎` | **open** the agent (you are in its session; detach to come back) |
| `x` `x` | **stop** it |
| `R` | **resume** what a reboot stopped (on a project: all of them) |

A **lane** is one agent on one task. You don't need roles, a coordinator or a chat room: just
lanes, and a screen that tells you which one needs you.

- **Claude Code** reports its own state (`claude agents --json`). For **Codex** and
  **opencode**, run `seldon setup` once and they report theirs too.
- **The watcher** (`seldon up`) sends one desktop notification when an agent starts waiting
  on you, fails, or finishes. It's plain code, so it costs no tokens.
- **Holds** let agents on different projects take turns on the emulator, Unreal or the GPU:
  `seldon hold emulator`, `seldon release emulator`.
- **Other machines** show up in the same panel: `seldon machines add mini you@mini`. From a
  phone, `ssh` to any one of them and run `seldon`.

Everything, key by key and command by command: **[tools/seldon](tools/seldon/README.md)**.

## Add-ons

Each one installs with `seldon install <name>` and works on its own. None is needed for the
panel.

| | what it adds |
|---|---|
| **[foundation](modules/foundation)** | the plan: `docs/QUEUE.md`, `DONE.md`, `FACTS.md`, written only through a deterministic CLI. Recommended |
| **[apiary](modules/apiary)** | rooms where agents talk to each other (MCP or tmux), when one lane is not enough |
| **[factory](modules/factory)** | projects run through apiary rooms: `factory new "<idea>"`, a board, decisions |
| **[comb](modules/comb)** | secrets by name, a leak audit, one store across machines (SOPS + age) |
| **[bifrost](modules/bifrost)** | tmux + Tailscale: sessions that survive, one workspace across machines |
| **[demerzel](modules/demerzel)** | a fully local voice you talk to (MLX, Apple silicon) |

## Compared with

- **`claude agents`**: Claude Code's own agent view. It's excellent, but Claude-only, one
  machine, and has no plan. seldon reads it, and adds Codex, opencode, a plan, holds and
  other machines.
- **[herdr](https://github.com/herdrdev/herdr)**: a terminal multiplexer with an agent
  sidebar. It owns your terminals; seldon owns none and is organised around projects and a
  plan.
- **[nodeterm](https://nodeterm.dev)**: a desktop canvas app. seldon is a terminal app, MIT,
  and works over plain ssh from any phone.

## Credits — what we got inspired by

Parts of the stack started from, or were inspired by, other people's work:

| module | inspired by | what we took |
|---|---|---|
| **apiary** | [stoops-cli](https://github.com/stoops-io/stoops-cli) | forked from it — shared rooms for agents, then de-bloated |
| **foundation** | [groundwork](https://www.npmjs.com/package/@davidbalzan/groundwork) and [agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp) / [`groundwork-seam`](https://www.npmjs.com/package/@davidbalzan/groundwork-seam) by David Balzan | the writer-split seam, the ADR tripwire, tool-stamped facts (ideas only; no code) |
| **comb** | [SOPS](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age) | the encryption underneath; comb is a front-end over them |
| **Demerzel** | a local voice-assistant build shared on Reddit | the overall shape, since reworked (see its README) |

## Conventions across the stack

- **Secrets by reference.** Keys never live in code, transcripts, or a command
  line — they go through `comb run --with NAME -- <cmd>`.
- **Agnostic examples.** Docs and demos use a throwaway **Weather CLI** project
  with agents `ana` / `ben` — never a real product or customer data.
- **Independent releases.** Each module ships on its own; this repo pins nothing.
