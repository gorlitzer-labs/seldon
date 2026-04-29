# Bifrost

<p align="center">
  <img src="hero.png" alt="Bifrost" width="600" />
</p>

> *Bridge between realms. Multi-machine terminal workspace over Tailscale.*

---

Mac Mini at home running `caffeinate`, lid closed, doing the heavy lifting. MacBook in your backpack for the coffee shop. Phone in your pocket for when things break at 2am.

You're training a model on the home Mac. Four terminal panes open — GPU monitor, training logs, Claude Code refactoring the data pipeline, a shell for git. You close the laptop and walk to the café. Open the MacBook, `bifrost workspace` — same four panes, right where you left them. The model's still running. You start a new feature on the MacBook while the home Mac crunches numbers.

3pm, you're on the bus. Phone buzzes — the training finished. Pull out your phone, `bifrost gateway`, hop into the home Mac's pane, check the results, kick off the next run. Put the phone away.

At work, both machines are yours. Home Mac compiling, work Mac serving — two clusters, one workspace. You're orchestrating double the compute from a single screen. Need to check the home build? Glance at the red-tinted window. Deploy from work? It's the blue one. Your phone is the remote control that can reach either at any time through the gateway.

Every pane is a tmux session. Nothing is lost. No machine ever sleeps. You're always one SSH away from any session on any machine.

That's it. That's the tool.

```
  CONTROLLER (your Mac)
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  bifrost workspace                                   │
  │       │                                              │
  │       ├── local-1..4                                 │
  │       ├── SSH ──→ asgard-1..4                        │
  │       └── SSH ──→ tatooine-1..4                      │
  │                                                      │
  │  LOCAL (black)   ASGARD (red)   TATOOINE (blue)      │
  │  ┌─────┬─────┐  ┌─────┬─────┐  ┌─────┬─────┐       │
  │  │🐝 1 │🦋 2 │  │🔥 1 │🌀 2 │  │💎 1 │🚀 2 │       │
  │  ├─────┼─────┤  ├─────┼─────┤  ├─────┼─────┤       │
  │  │🐞 3 │🪲 4 │  │⚡ 3 │🎯 4 │  │🌊 3 │🍄 4 │       │
  │  └─────┴─────┘  └─────┴─────┘  └─────┴─────┘       │
  └──────────────────────────────────────────────────────┘
                         │                │
                   Tailscale SSH    Tailscale SSH
                         │                │
                         ▼                ▼
                ┌──────────────┐  ┌──────────────┐
                │ asgard (Mac) │  │ tatooine (🐧)│
                │ needs: tmux  │  │ needs: tmux  │
                └──────────────┘  └──────────────┘
                         ▲                ▲
                         └──────┬─────────┘
                                │
                         📱 phone / iPad
                         ssh → bifrost gateway
```

| Role | Install | Purpose |
|---|---|---|
| **Controller** | bifrost + tmux + iTerm2 + Tailscale | Manages everything |
| **Device** | tmux only | Hosts sessions (created over SSH) |
| **Client** | SSH only | Attaches to sessions |

## Install

```bash
# Controller
cp bifrost ~/bin/ && chmod +x ~/bin/bifrost

# Devices — just tmux
brew install tmux    # macOS
sudo apt install tmux  # Linux
```

## Quick start

```bash
bifrost doctor              # check prerequisites
bifrost device scan         # find Tailscale devices
bifrost device add asgard   # add a device
bifrost workspace           # launch
```

From phone:
```bash
ssh my-mac && bifrost gateway   # pick a session, auto-hop
```

## Sessions

```
bifrost device add asgard    →  asgard-1, asgard-2, asgard-3, asgard-4
bifrost device add tatooine  →  tatooine-1, tatooine-2, tatooine-3, tatooine-4
local (always)               →  local-1, local-2, local-3, local-4
```

## Commands

```bash
# Devices
bifrost device scan/add/remove/list

# Launch (macOS + iTerm2)
bifrost workspace           # 2x2 grid per device
bifrost mobile              # tmux tabs
bifrost direct              # split panes

# Connect (everywhere)
bifrost gateway             # interactive session picker
bifrost sessions            # visual map
bifrost attach <session>    # direct attach
bifrost run <device> <cmd>  # remote command
bifrost status              # overview

# Manage
bifrost doctor              # prerequisites
bifrost upgrade             # update to latest
bifrost kill                # tear down everything
bifrost quickstart          # onboarding guide
bifrost help                # command reference
```

## Releasing

Bump `BIFROST_VERSION` in the script, push to main. GitHub Action auto-creates a release.

- **Patch** (1.2.0 → 1.2.1) — fixes
- **Minor** (1.2.0 → 1.3.0) — features
- **Major** (1.0.0 → 2.0.0) — breaking
