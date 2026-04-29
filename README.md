<p align="center">
  <img src="hero.png" alt="Bifrost" width="100%" />
</p>

<h1 align="center">Bifrost</h1>

<p align="center">
  <strong>Bridge between realms. Dual-machine terminal workspace.</strong>
</p>

---

Bifrost launches a multi-pane iTerm2 workspace across two machines over Tailscale SSH. Each pane runs its own tmux session — work on desktop, pick up from your phone. Remote connections auto-reconnect on reboot or network drops.

## Requirements

- Two machines on the same [Tailscale](https://tailscale.com) network
- **tmux** on both machines
- **iTerm2** on the machine you launch from (macOS)
- SSH access between machines (Tailscale handles this)

## Install

Bifrost only needs to be installed on your **primary machine** — the one you launch workspaces from. It SSHs into the remote to create tmux sessions there.

```bash
# On your primary Mac
cp bifrost ~/bin/
chmod +x ~/bin/bifrost
```

The remote machine just needs **tmux** installed — bifrost creates and manages sessions over SSH.

```bash
# On your remote Mac (if tmux isn't installed)
brew install tmux
```

### Termux (Android)

Install bifrost on your phone to attach to sessions created by your Mac:

```bash
# On Termux
pkg install openssh tmux
mkdir -p ~/bin

# Copy from your Mac (over Tailscale), or clone the repo
scp your-mac:~/bin/bifrost ~/bin/bifrost
chmod +x ~/bin/bifrost
bifrost setup
```

## Setup

First run — configure your remote machine:

```bash
bifrost setup
# Remote hostname (Tailscale): your-machine
# SSH user on remote [you]:
# Testing SSH... Connected.
# Config saved to ~/.config/bifrost/config
```

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                    YOUR PRIMARY MAC                      │
│                                                          │
│  bifrost workspace                                       │
│       │                                                  │
│       ├── creates 4 local tmux sessions (local-1..4)     │
│       ├── SSHs into remote, creates 4 tmux sessions      │
│       └── opens 2 iTerm windows with 2x2 grids           │
│                                                          │
│  Window 1: LOCAL          Window 2: REMOTE (red tint)    │
│  ┌────────┬────────┐      ┌────────┬────────┐            │
│  │local-1 │local-2 │      │remote-1│remote-2│ ← SSH      │
│  ├────────┼────────┤      ├────────┼────────┤   tunnels   │
│  │local-3 │local-4 │      │remote-3│remote-4│             │
│  └────────┴────────┘      └────────┴────────┘             │
└──────────────────────────────┼────────────────────────────┘
                               │ Tailscale SSH
┌──────────────────────────────┼────────────────────────────┐
│                    YOUR REMOTE MAC                        │
│                                                           │
│  tmux sessions: remote-1, remote-2, remote-3, remote-4   │
│  (created by bifrost over SSH — nothing to install)       │
└───────────────────────────────────────────────────────────┘
```

**From your phone** — attach to any session directly:

```
┌─────────────┐
│   PHONE     │
│  (Termux /  │──── ssh <remote> ──→ tmux attach -t remote-2
│  Blink)     │──── ssh <local>  ──→ tmux attach -t local-1
└─────────────┘
   or: bifrost attach remote-2
```

## Commands

```bash
# Setup
bifrost setup                 # configure remote hostname interactively
bifrost help                  # full usage reference

# Inspect
bifrost status                # show active sessions + remote connectivity
bifrost run <cmd>             # run a command on remote (e.g. bifrost run uptime)

# Launch (macOS + iTerm2)
bifrost workspace             # 2x2 grid on both machines
bifrost mobile                # two tabs with tmux sessions
bifrost direct                # side-by-side split panes (no tmux)

# Connect (works everywhere — Mac, Termux, Linux)
bifrost attach <session>      # attach to a session (e.g. bifrost attach remote-2)

# Cleanup
bifrost kill                  # tear down all bifrost tmux sessions
```

## Modes

### workspace

Two iTerm windows — local (black bg) and remote (red-tinted bg) — each with a 2x2 grid of panes. Every pane is its own tmux session with a random emoji label for easy identification.

Remote panes auto-reconnect if the connection drops (reboot, network blip).

### mobile

Two iTerm tabs with persistent tmux sessions. Designed for reattaching from your phone.

### direct

Single iTerm window, side-by-side splits. Left = local, right = remote (red tint). No tmux — direct SSH connection.
