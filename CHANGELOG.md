# Changelog

## v1.1.2

- **Fix: TUI input corruption** — incoming room events are now batched (80ms flush) so messages no longer float/merge with your typing mid-keystroke
- **Idle agent tracking** — agent status bar shows green (idle), yellow (busy), dim+zzz (stale), or grey (unknown)
- **Scrollable input** — multi-line input viewport caps at 6 lines with scroll indicators, keeps cursor in view

## v1.1.1

- **Fix: duplicate tab icons** — terminal tab emojis are now stable per agent/room name instead of random, preventing duplicate icons when running multiple agents

## v1.1.0

- **`@all` broadcast mention** — `@all` in a message fires a MentionedEvent for every participant in the room, waking agents in standby modes. Deduplicates with explicit `@name` mentions. TUI autocomplete suggests `@all`
- **Reserved mention tokens** — `"all"` is rejected as a participant name/identifier at connect time

## v1.0.2

- **Version in help** — `apiary --help` and `make help` now show current version

## v1.0.6

- **Stale agent indicator** — agents that don't respond within 5 minutes show `zzz` in dim, hinting to `/ping` them

## v1.0.5

- **Color-based agent status** — green name = idle, yellow = busy. No extra characters, wraps cleanly on narrow/mobile terminals
- **Unified stall timeout** — force-injects after 30s in any blocking state (streaming, unknown, dialog), ensuring `/ping` always reaches stuck agents

## v1.0.4

- **Agent activity spinners** — 4 random spinner styles per agent, green `✓` when idle
- **Smart busy/idle on join** — checks recent messages to determine if agents are working or idle
- **Fix: PingEvent type** — was using wrong event name, pings now correctly mark agents busy
- **Fix: tmux stall** — capture window 15→30 lines, force-inject after ~5s of unknown state

## v1.0.3

- **Agent activity spinners** — busy agents show animated spinners (4 random styles per agent), idle agents show `●`
- **Fix: tmux state detection stall** — capture window expanded from 15 to 30 lines; force-injects after ~5s of unknown state to prevent agents getting stuck

## v1.0.1

- **Fix: kicked participants linger in autocomplete** — `/kick` now removes participants from suggestions and `/who` list (was only handled for `/leave`)

## v1.0.0

First stable release. CLI surface, MCP tools, and event model locked under semver.

All prior 0.x changes folded in — see below for history.

## v0.4.6

- **`/sound` toggle** — toggle notification sounds on/off, on by default, persisted across sessions
- **Persistent config** — `~/.apiary/config.json` for user preferences
- **Docs updated** — README, Makefile, `--help`, CLAUDE.md reflect all new commands

## v0.4.5

- **`/tunnel` command** — start a cloudflared tunnel mid-session without restarting (admin only)
- **`apiary ps` shows rooms** — running rooms display with ready-to-paste join links
- **24h share token TTL** — share links last a full day instead of expiring after 1 hour
- **Room session persistence** — room info saved to `~/.apiary/sessions/` for discovery via `apiary ps`

## v0.4.4

- **Bordered message boxes** — messages wrapped in rounded borders with sender-colored outlines
- **Compact layout** — narrower terminals (< 80 cols) get a streamlined layout
- **Inline reply tags** — reply indicators shown in message header instead of separate lines

## v0.4.3

- **Ping triggers immediate response** — pings now interrupt active agents so they respond with status right away instead of buffering
- **Ping rendered in yellow** — distinct visual for ping notifications in TUI
- **Sound on all messages** — terminal bell fires for all incoming messages, not just pings
- **Zebra striping** — alternating message brightness for easier reading of consecutive bot messages
- **Bee wings** — black veins in ASCII bee (bees are black and yellow, not white and yellow)
- **Input wrapping** — long pasted text wraps properly instead of breaking the TUI layout

## v0.4.0 – v0.4.2

- **Codex runtime** — `apiary codex` launches Codex agents with tmux + bracketed paste delivery
- **`/help` command** — in-TUI command reference with welcome hint on room join
- **Positional names** — `apiary room brood-box Overlord` instead of `--name Overlord` everywhere
- **Flag forwarding** — unknown flags auto-forwarded to underlying CLI (`--model sonnet`)
- **`apiary --version`** — version display
- **`apiary stop --all`** — stop all running agents at once
- **Detach/resume** — `Ctrl+B D` to detach agent sessions, `--resume` to re-attach
- **Default room renamed** — `brood-box` as the default room name

## v0.3.3

- **Colored CLI** — styled help output, banners, server info, terminal tab titles
- **`make setup`** — one-command install with npm link
- **Self-update** — `apiary update` pulls latest + rebuilds; nags on startup when outdated
- **`make release`** — bump version, tag, push with optional release notes
- **ASCII bee banner** — amber/gold gradient bee in TUI

## Fork from stoops-cli

- **Rebranded** — `stoops` → `apiary` across CLI, MCP tools, tmux sessions, config paths
- **Security hardening** — localhost-only by default, Authorization header auth, CORS validation, token expiration/rotation/revocation, rate limiting, input validation
- **SSE heartbeat** — prevents idle connection drops behind proxies
- **TUI word wrap** — messages wrap correctly in narrow terminals
- **LAN-aware share URLs** — `--expose` uses LAN IP in share links
- **Session management** — detach/resume Claude Code sessions (`Ctrl+B D` / `--resume`)
