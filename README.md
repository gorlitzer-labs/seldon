# Bifrost

<p align="center">
  <img src="hero.png" alt="Bifrost" width="600" />
</p>

> *Bridge between realms. One terminal workspace, spread across all your machines.*

---

## What it is

Bifrost turns several computers into a **single terminal workspace** you can reach
from anywhere — your desk, a café, your phone.

Under the hood it's just two trusted tools wired together: **tmux** (persistent
terminal sessions) and **Tailscale** (a private network between your machines).
Plain tmux dies when your shell does. Bifrost makes your sessions, scrollback,
and running processes survive — closing the laptop, switching Wi-Fi, even
rebooting the machine you're connecting *from*.

## The names (so they're not a mystery)

Bifrost borrows from Norse myth — the **Bifröst** is the rainbow bridge that
links the worlds. The metaphor is the whole mental model, so here it is once,
plainly:

| Name | Who it is | Runs on | Needs to be installed |
|---|---|---|---|
| **Heimdall** — *guardian of the bridge* | Your primary machine. Runs bifrost and drives everything. | macOS / Linux / Android (Termux) | bifrost + tmux + Tailscale |
| **Realm** — *a connected world* | Any remote machine that hosts sessions. | macOS / Linux | tmux + Tailscale + your SSH key |
| **Raven** — *Odin's roaming scout* | A phone, tablet, or laptop you hop in from. | anything with SSH | nothing — just an SSH client |

In short: **Heimdall** is the machine you sit at, **Realms** are the machines it
reaches over the network, and a **Raven** is whatever you happen to be holding
when you want to check in.

## When to use it

- **Long-running work at home** (a training run, a build, a server) you want to
  watch from anywhere.
- **Several machines as one desk** — home compiles, work serves, both reachable
  from one place.
- **Same sessions, any screen** — a 2×2 visual grid on the Mac (iTerm2), or
  plain tmux tabs on a phone.

### A typical day

🏠 Start a training run at home — 4 panes (GPU, logs, Claude Code, shell). Close the lid, walk out.

☕ `bifrost workspace` from the laptop — same 4 panes, right where you left them, while home keeps crunching.

📱 Phone buzzes when the run finishes. `ssh home && bifrost gateway` — pick a session, hop in, kick off the next one.

*Every pane is a tmux session. Nothing is lost. No machine sleeps.*

---

## Architecture

```
   HEIMDALL (the machine you sit at)
   └── bifrost workspace
         ├── local-1..4               sessions on Heimdall itself
         ├── SSH ──→ asgard-1..4      a Realm  (red grid)
         └── SSH ──→ tatooine-1..4    a Realm  (blue grid)

   All traffic rides Tailscale SSH — no ports exposed to the internet.

         📱 Raven (phone) ──ssh──→ Heimdall ──→ "bifrost gateway" ──→ any session
```

On macOS with iTerm2, each Realm opens as its own window with a colour-tinted
2×2 grid. On Linux or Termux, the same sessions show up as tmux tabs instead.

---

## Prerequisites

| Machine | Required |
|---|---|
| **Heimdall** (your primary) | Tailscale node, SSH client, `tmux ≥ 3.0`. iTerm2 optional (enables the 2×2 grid on macOS). |
| **Realm** (any remote) | Tailscale node on the same tailnet, `tmux ≥ 3.0`, SSH server, your public key in `~/.ssh/authorized_keys`. |
| **Raven** (phone/tablet) | Tailscale + any SSH client (Blink, Termius, Termux). No bifrost install needed. |

Quick check from Heimdall:
```bash
tailscale status            # all machines listed and reachable?
ssh <realm-host> tmux -V    # SSH key works and tmux is installed?
```

> **Tip:** run `tailscale up --ssh` on each Realm so SSH is gated by your tailnet
> — no need to expose port 22 to the internet.

---

## Install

**One-liner** (macOS, Linux, Termux):
```bash
curl -fsSL https://raw.githubusercontent.com/gorlitzer-labs/bifrost/main/install.sh | bash
```

It checks dependencies, installs `bifrost`, generates a `tmux.conf`, and (on
Termux) creates home-screen widget shortcuts.

**Manual:**
```bash
cp bifrost ~/bin/ && chmod +x ~/bin/bifrost
bifrost setup          # one-time config (see below)
```

Realms only need tmux — nothing else to install there:
```bash
brew install tmux       # macOS
sudo apt install tmux   # Linux
pkg install tmux        # Termux (Android)
```

---

## First run

Four steps, start to finish:

```bash
bifrost setup               # 1. one-time config (host + SSH user, tmux.conf)
bifrost realm scan          # 2. see which Tailscale machines are available
bifrost realm add asgard    # 3. add a realm (tests SSH, copies your key, syncs config)
bifrost workspace           # 4. launch — opens a grid/tabs for every realm
```

**What `bifrost setup` does:** an interactive, one-time step. It asks for a
default remote host and SSH user, tests the connection, and writes two files
under `~/.config/bifrost/`:

| File | Purpose |
|---|---|
| `config` | Default remote host + SSH user (used by `mobile` / `direct`). |
| `tmux.conf` | Platform-aware tmux config (mouse off on Termux). Regenerated every run. |

Safe to re-run any time to change defaults or regenerate `tmux.conf`.

**What `bifrost realm add <name>` does:** the real multi-machine workflow. It
auto-detects the machine on Tailscale, tests SSH (offering to copy your key if
key auth isn't set up yet), syncs `tmux.conf` to it, and saves it as one file
under `~/.config/bifrost/realms/`. The name you give it becomes the session
prefix: `asgard` → `asgard-1 … asgard-4`.

**From a phone (Raven):**
```bash
ssh my-mac && bifrost gateway   # pick a session from a list, auto-hop in
```

---

## Commands

```bash
# Setup & realms
bifrost setup                  # one-time config (host, SSH user, tmux.conf)
bifrost realm scan             # discover Tailscale machines
bifrost realm add <name>       # add a realm (auto-syncs tmux.conf)
bifrost realm list / remove    # manage realms

# Launch
bifrost workspace              # ★ the main one — a grid/tabs for ALL realms
bifrost mobile                 # simple tmux tabs: Heimdall + your default remote
bifrost direct                 # split panes: Heimdall + your default remote

# Connect (works anywhere — Raven-friendly)
bifrost gateway                # interactive session picker, then auto-hop
bifrost sessions               # visual map of every session
bifrost attach <session>       # attach directly
bifrost run <realm> <cmd>      # run one command on a realm
bifrost status                 # connectivity overview

# Manage
bifrost sync                   # push tmux.conf to all realms
bifrost doctor                 # check prerequisites
bifrost upgrade                # update to latest
bifrost kill                   # tear down all sessions
bifrost quickstart / help      # guided onboarding / command reference
```

> **`workspace` vs `mobile`/`direct`:** `workspace` spans every realm you've
> added. `mobile` and `direct` are lightweight layouts that connect Heimdall to
> just the single *default remote* from `bifrost setup` — handy for a quick
> two-machine view, but they don't fan out across all realms.

---

## Sessions

```
bifrost realm add asgard    →  asgard-1, asgard-2, asgard-3, asgard-4
bifrost realm add tatooine  →  tatooine-1, tatooine-2, tatooine-3, tatooine-4
local (always present)      →  local-1, local-2, local-3, local-4
```

---

## tmux config

Bifrost manages its own `~/.config/bifrost/tmux.conf` on every machine:

- generated by `bifrost setup` (platform-aware — mouse off on Termux),
- pushed to all realms with `bifrost sync`,
- auto-synced when you run `bifrost realm add`.

Sessions bifrost creates use this config automatically, so behaviour is
consistent across macOS, Linux, and Termux.

---

## Termux (Android)

Bifrost runs natively on Termux as a Heimdall:

```bash
# 1. Install Termux from F-Droid (NOT the Play Store — that version is outdated)
#    https://f-droid.org/en/packages/com.termux/

# 2. Install bifrost + dependencies:
curl -fsSL https://raw.githubusercontent.com/gorlitzer-labs/bifrost/main/install.sh | bash

# 3. Set up and launch:
bifrost setup
bifrost realm add my-mac
bifrost workspace            # one tmux window per active session
```

Mouse mode is disabled automatically on Termux so the soft keyboard keeps
working. Scroll with `Ctrl-b [` (copy mode), then arrow keys or Page Up/Down.

**Optional — home-screen shortcuts:** install
[Termux:Widget](https://f-droid.org/en/packages/com.termux.widget/) from F-Droid,
then long-press home → Widgets → Termux:Widget → tap `bifrost-gateway`.

---

## Running a Mac as a headless home node

<details>
<summary><b>Home-server setup tips</b> — keep it awake, lid closed, battery healthy, and reachable after a reboot (click to expand)</summary>

Set it up once, forget about it.

### Stay awake (survives reboots, not just this login)

`caffeinate` is a process — it dies on reboot or power cut. For a real always-on
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

Either works. Plug in power, plug in display (or BetterDummy), close the lid.

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
  pre-boot unlock screen after any reboot/power cut — Tailscale isn't running
  yet. macOS 26 (Tahoe) added pre-boot SSH unlock, but it needs **wired
  Ethernet** and a **password** (SSH keys don't work pre-boot). Pre-Tahoe: the
  only options are disabling FileVault on the server node, or accepting a
  physical trip home after power failures.
- **Tailscale key expiry.** Tailscale auth keys expire (default 180 days). For
  a 24/7 server, disable expiry on that node in the admin console
  (Machines → ⋮ → Disable key expiry).
- **Lock down SSH.** Run `tailscale up --ssh` so SSH access is gated by your
  tailnet ACL — no need to expose port 22 even on the LAN.

Keep it plugged in. BetterDummy or dummy plug. Close the lid, walk away. SSH in
from anywhere via Tailscale.

</details>

---

## Releasing

Bump `BIFROST_VERSION` in the `bifrost` script and push to main — a GitHub
Action creates the release automatically.

- **Patch** (1.3.0 → 1.3.1) — fixes
- **Minor** (1.3.0 → 1.4.0) — features
- **Major** (1.0.0 → 2.0.0) — breaking
