# Bifrost

<p align="center">
  <img src="hero.png" alt="Bifrost" width="600" />
</p>

> *Bridge between realms. Multi-machine terminal workspace over Tailscale.*

---

### The idea

A Mac at home running `caffeinate`. Always on. We don't sleep.

MacBook in your backpack. Phone in your pocket. All on Tailscale.

### The workflow

🏠 **Home** — Training a model. Four panes: GPU monitor, logs, Claude Code rewriting your pipeline, a shell. Close the laptop, walk out. The model keeps running.

☕ **Café** — `bifrost workspace`. Same four panes, right where you left them. Start a new feature while the home Mac crunches numbers 40km away.

🚌 **Bus** — Phone buzzes, training done. `bifrost gateway`, hop into the home Mac, check results, kick off the next run. The guy next to you thinks you're texting. You just deployed from a bus.

🏢 **Office** — Both machines are yours. Home compiling, work serving — your own cluster. Red window is home. Blue is work. Phone reaches either through the gateway.

### The point

Every pane is a tmux session. Nothing is lost. No machine sleeps. One `ssh` away from everything.

*We built it because we could.*

---

## Architecture

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

---

## Install

```bash
# Controller
cp bifrost ~/bin/ && chmod +x ~/bin/bifrost

# Devices — just tmux
brew install tmux    # macOS
sudo apt install tmux  # Linux
```

---

## Quick start

```bash
bifrost doctor              # check prerequisites
bifrost device scan         # find Tailscale devices
bifrost device add asgard   # add a device
bifrost workspace           # launch
```

**From phone:**
```bash
ssh my-mac && bifrost gateway   # pick a session, auto-hop
```

---

## Sessions

```
bifrost device add asgard    →  asgard-1, asgard-2, asgard-3, asgard-4
bifrost device add tatooine  →  tatooine-1, tatooine-2, tatooine-3, tatooine-4
local (always)               →  local-1, local-2, local-3, local-4
```

---

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

---

## Home server tips

Running a MacBook as a headless home node? Set it up once, forget about it:

```bash
# Prevent idle sleep (runs in background, survives logout)
tmux new-session -d -s caffeinate 'caffeinate -s'  # bury it and forget

# Lid closed? Plug in an HDMI dummy plug (~$5) for clamshell mode.
# Apple Silicon ignores pmset disablesleep — the lid magnet is hardware-level.
# Dummy plug + power adapter = Mac stays awake with lid closed.

# Cap battery at 80% — lithium lives longer below 100%
brew install battery        # actuallymentor/battery (free, open source)
battery maintain 80         # runs as daemon, survives reboots
```

Keep it plugged in. HDMI dummy plug in. Close the lid, walk away. SSH in from anywhere via Tailscale.

To undo:
```bash
battery maintain stop       # remove charge limit
```

---

## Releasing

Bump `BIFROST_VERSION` in the script, push to main. GitHub Action auto-creates a release.

- **Patch** (1.2.0 → 1.2.1) — fixes
- **Minor** (1.2.0 → 1.3.0) — features
- **Major** (1.0.0 → 2.0.0) — breaking
