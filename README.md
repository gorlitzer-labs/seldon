<p align="center">
  <img src="hero.png" alt="Bifrost" width="100%" />
</p>

<h1 align="center">Bifrost</h1>

<p align="center">
  <strong>Bridge between realms. Dual-machine terminal workspace.</strong>
</p>

---

Bifrost launches a multi-pane iTerm2 workspace across two machines over Tailscale SSH. Each pane runs its own tmux session — work on desktop, pick up from your phone. Remote connections auto-reconnect on reboot or network drops.

## Install

```bash
cp bifrost ~/bin/
chmod +x ~/bin/bifrost
```

Requires: iTerm2, tmux, Tailscale (for SSH between machines).

## Setup

First run — configure your remote machine interactively:

```bash
bifrost setup
# Remote hostname (Tailscale): your-machine
# SSH user on remote [you]: 
# Testing SSH... Connected.
# Config saved to ~/.config/bifrost/config
```

Config is stored in `~/.config/bifrost/config`. Env vars (`WORKBENCH_REMOTE`, `WORKBENCH_USER`) override it if set.

## Usage

```bash
bifrost workspace   # 2x2 grid on both machines (two windows, 8 tmux sessions)
bifrost mobile      # tmux sessions (reattach from phone via Blink Shell)
bifrost direct      # iTerm split panes with direct SSH (mac-to-mac)
bifrost kill        # tear down all sessions
```

## Modes

### workspace

Two iTerm windows — local (black bg) and remote (red-tinted bg) — each with a 2x2 grid of panes. Every pane is its own tmux session with a random emoji label for easy identification.

```
LOCAL                            REMOTE (red tint)
┌──────────┬──────────┐          ┌──────────┬──────────┐
│🐝 local-1│🦋 local-2│          │🔥 remote-1│🌀 remote-2│
├──────────┼──────────┤          ├──────────┼──────────┤
│🐞 local-3│🪲 local-4│          │💎 remote-3│🚀 remote-4│
└──────────┴──────────┘          └──────────┴──────────┘
```

Remote panes auto-reconnect if the connection drops (reboot, network blip).

From your phone:
```bash
ssh <remote> && tmux attach -t remote-2
```

### mobile

Two iTerm tabs with persistent tmux sessions. Reconnect from phone:
```bash
ssh <remote> && tmux attach -t remote
ssh <local>  && tmux attach -t local
```

### direct

Single iTerm window, side-by-side splits. Left = local (black), right = remote (red tint). No tmux.
