# Changelog

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
