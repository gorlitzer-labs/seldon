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
  HEIMDALL (your machine)
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  bifrost workspace                                   │
  │       │                                              │
  │       ├── local-1..4                                 │
  │       ├── SSH ──→ asgard-1..4    (Realm)             │
  │       └── SSH ──→ tatooine-1..4  (Realm)             │
  │                                                      │
  │  HEIMDALL (black) ASGARD (red)   TATOOINE (blue)     │
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
                │  Realm       │  │  Realm       │
                │  needs: tmux │  │  needs: tmux │
                └──────────────┘  └──────────────┘
                         ▲                ▲
                         └──────┬─────────┘
                                │
                         📱 Raven (phone)
                         ssh → bifrost gateway
```

| Role | What | Install | Purpose |
|---|---|---|---|
| **Heimdall** | Your primary machine | bifrost + tmux + Tailscale | Manages everything |
| **Realm** | Any remote machine | tmux only | Hosts sessions (created over SSH) |
| **Raven** | Phone, iPad, laptop | SSH only | Attaches to sessions |

Heimdall works on macOS (with iTerm2 for visual grids), Linux, and Android via Termux.

---

## Install

**One-liner** (macOS, Linux, Termux):
```bash
curl -fsSL https://raw.githubusercontent.com/gorlitzer-labs/bifrost/main/install.sh | bash
```

Installs bifrost + dependencies, generates tmux.conf, and on Termux creates home screen widget shortcuts.

**Manual:**
```bash
# Heimdall (your primary machine)
cp bifrost ~/bin/ && chmod +x ~/bin/bifrost
bifrost setup   # generates tmux.conf + config

# Realms — just tmux
brew install tmux    # macOS
sudo apt install tmux  # Linux
pkg install tmux     # Termux (Android)
```

**Termux (Google Pixel / Android):**
```bash
# 1. Install Termux from F-Droid (not Play Store — the Play Store version is outdated)
#    https://f-droid.org/en/packages/com.termux/

# 2. Open Termux and run:
curl -fsSL https://raw.githubusercontent.com/gorlitzer-labs/bifrost/main/install.sh | bash

# 3. Optional: Install Termux:Widget from F-Droid for home screen shortcuts
#    https://f-droid.org/en/packages/com.termux.widget/
#    Long-press home → Widgets → Termux:Widget → tap bifrost-gateway
```

---

## Quick start

```bash
bifrost doctor              # check prerequisites
bifrost realm scan          # find Tailscale machines
bifrost realm add asgard    # add a realm (auto-syncs tmux.conf)
bifrost workspace           # launch
```

**From phone (Raven):**
```bash
ssh my-mac && bifrost gateway   # pick a session, auto-hop
```

---

## Sessions

```
bifrost realm add asgard    →  asgard-1, asgard-2, asgard-3, asgard-4
bifrost realm add tatooine  →  tatooine-1, tatooine-2, tatooine-3, tatooine-4
local (always)              →  local-1, local-2, local-3, local-4
```

---

## Commands

```bash
# Realms
bifrost realm scan/add/remove/list

# Launch (auto-detects iTerm2 or tmux-native)
bifrost workspace           # 2x2 grid per realm
bifrost mobile              # tmux tabs
bifrost direct              # split panes

# Connect (everywhere — Raven-friendly)
bifrost gateway             # interactive session picker
bifrost sessions            # visual map
bifrost attach <session>    # direct attach
bifrost run <realm> <cmd>   # remote command
bifrost status              # overview

# Manage
bifrost sync                # push tmux.conf to all realms
bifrost doctor              # prerequisites
bifrost upgrade             # update to latest
bifrost kill                # tear down everything
bifrost quickstart          # onboarding guide
bifrost help                # command reference
```

---

## Termux (Android)

Bifrost runs natively on Termux as Heimdall:

```bash
pkg install tmux openssh
cp bifrost ~/bin/ && chmod +x ~/bin/bifrost
bifrost setup
bifrost realm add my-mac
bifrost workspace   # tmux windows per active session
```

Mouse mode is automatically disabled on Termux to keep the soft keyboard working.
Scroll with `Ctrl-b [` (copy mode), then arrow keys or Page Up/Down.

---

## Unified tmux config

Bifrost manages its own `~/.config/bifrost/tmux.conf` on every machine:

- Generated by `bifrost setup` (platform-aware: mouse on/off for Termux)
- Pushed to all realms with `bifrost sync`
- Auto-synced when adding a realm with `bifrost realm add`
- Sessions created by bifrost use this config automatically

This ensures consistent behavior across macOS, Linux, and Termux.

---

## Home server tips

Running a MacBook as a headless home node? Set it up once, forget about it.

### Stay awake (survives reboots, not just this login)

`caffeinate` is a process — it dies on reboot or power-cut. For a real always-on
server, set the power policy in `pmset`:

```bash
# Plugged-in profile: never sleep, never disk-sleep, restart after power cut.
sudo pmset -c sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1
```

On macOS Tahoe 26.5+ add `autorestartatconnect 1` so the Mac wakes the moment
power is reconnected.

### Clamshell mode (lid closed)

Apple Silicon enforces lid-close sleep at the firmware level — `pmset
disablesleep` is **ignored**. You need a display (real or virtual) for clamshell
mode:

- **Software-only:** [BetterDummy](https://github.com/waydabber/BetterDummy) —
  free, open source, no dongle.
- **Hardware:** any HDMI or USB-C dummy plug (~$5).

Either works. Plug in power, plug in display (or BetterDummy), close lid.

### Cap battery charge (battery longevity)

Cycling lithium between ~20–80% extends pack life. Today (2026) macOS does this
natively:

- **macOS Tahoe 26.4+** (Feb 2026) — System Settings → Battery → Charging → tap
  the info icon → **Charge Limit** (80/85/90/95/100%). Use this first.
- **Older macOS** — [actuallymentor/battery](https://github.com/actuallymentor/battery):

  ```bash
  brew install --cask battery   # GUI app — open it once to finish CLI setup
  battery maintain 80           # daemon, survives reboots
  battery maintain stop         # undo
  ```

### Gotchas (read these once)

- **FileVault + reboot = no SSH.** A FileVault-encrypted Mac stops at the
  pre-boot unlock screen after any reboot/power-cut — Tailscale isn't running
  yet. macOS 26 (Tahoe) added pre-boot SSH unlock, but it needs **wired
  Ethernet** and a **password** (SSH keys don't work pre-boot). Pre-Tahoe: the
  only options are disabling FileVault on the server node, or accepting a
  physical trip home after power failures.
- **Tailscale key expiry.** Tailscale auth keys expire (default 180 days). For
  a 24/7 server, disable expiry on that node in the Tailscale admin console
  (Machines → ⋮ → Disable key expiry).
- **Lock down SSH.** Run `tailscale up --ssh` so SSH access is gated by your
  tailnet ACL — no need to expose port 22 even on the LAN.

Keep it plugged in. BetterDummy or dummy plug. Close the lid, walk away.
SSH in from anywhere via Tailscale.

---

## Releasing

Bump `BIFROST_VERSION` in the script, push to main. GitHub Action auto-creates a release.

- **Patch** (1.3.0 → 1.3.1) — fixes
- **Minor** (1.3.0 → 1.4.0) — features
- **Major** (1.0.0 → 2.0.0) — breaking
