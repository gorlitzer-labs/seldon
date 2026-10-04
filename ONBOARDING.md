# Onboarding — ten minutes to your first agents

This takes you from nothing to a few agents working on a repo, with one screen telling you
which one needs you. Examples use a throwaway **Weather CLI** repo.

## What you need

- **Node 20+**, **git** and **tmux**
- At least one agent CLI, signed in: [Claude Code](https://code.claude.com) (`claude`),
  [Codex](https://developers.openai.com/codex) (`codex`) or [opencode](https://opencode.ai) (`opencode`)
- macOS or Linux (a phone works too, over ssh)

## 1. Install and open it (1 min)

```bash
npm i -g @gorlitzer-labs/seldon
cd ~/code/weather-cli
seldon
```

You see the panel: this repo, and any agents already running on the machine.

## 2. Start an agent on a task (1 min)

Press **`n`**, type `add a --units flag`, press **⏎**, then pick **`1`** claude, **`2`** codex
or **`3`** opencode.

The agent starts on its own branch, in its own worktree, so it never touches your checkout or
another agent's. It shows up as a **lane**:

```text
  ❯ weather-cli
      ● add-a-units-flag           claude    working                                  0s
```

Press **⏎** on it to jump into its session. Detach (`←` on an empty prompt in Claude, or
`ctrl+b d` in tmux) to come back.

## 3. Give it a plan (2 min)

```bash
seldon install foundation
foundation init
foundation queue "(P1) add a --units flag"
foundation queue "(P2) cache the last forecast"
```

In the panel, **`p`** shows the plan. **⏎** on an item starts a lane on it, and each item
shows the lane working on it.

## 4. Let it tell you when it needs you (1 min)

```bash
seldon up       # the watcher: one notification when an agent waits on you, fails or finishes
seldon setup    # once, if you use Codex or opencode: they report their own state too
```

Codex runs a new hook only after you trust it: open `codex`, run `/hooks`, trust seldon's.

## 5. Stop agents fighting over the emulator (1 min)

When agents on *different* projects share one emulator, Unreal or GPU, have them take turns:

```bash
seldon hold emulator     # yours, or "held by stranded/fix-save-crash · 6m" and exit 2
seldon release emulator
```

Put the rule in your agents' instructions once (the [README](tools/seldon/README.md#holds--taking-turns-on-shared-things) has the snippet).

## 6. Other machines and your phone (optional)

```bash
seldon machines add mini you@mini.tailnet.ts.net    # needs seldon there, and ssh keys
```

The panel now lists mini's agents too, as `project @mini`. From a phone, `ssh` to any machine
and run `seldon`.

## The keys

| key | does |
|---|---|
| `n` | new lane |
| `p` | plan |
| `⏎` | open the agent |
| `x` `x` | stop it |
| `R` | resume after a reboot |
| `q` | quit (agents keep running) |

## Add-ons, when you feel the gap

| you want… | add |
|---|---|
| agents that talk to each other (hand-offs, reviews) | [apiary](modules/apiary) rooms, and [factory](modules/factory) to run projects through them |
| API keys that never land in a transcript | [comb](modules/comb) |
| tmux sessions that survive, across machines | [bifrost](modules/bifrost) |
| to talk to your machine | [demerzel](modules/demerzel) (Apple silicon) |

## Ground rules

- **Secrets by reference only:** `comb run --with NAME -- <cmd>`. Never paste a key into a
  file, a command or a chat. If one leaks, rotate it.
- **Agnostic examples:** Weather CLI, agents `ana` / `ben`. No real product, room or customer
  data in docs or demos.
- **Contributing:** never push to `main`. Use a feature branch, then `gh pr create`; checks
  must pass before merge.
