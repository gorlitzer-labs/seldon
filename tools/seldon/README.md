# @gorlitzer-labs/seldon

```
 ███████╗███████╗██╗     ██████╗  ██████╗ ███╗   ██╗
 ██╔════╝██╔════╝██║     ██╔══██╗██╔═══██╗████╗  ██║
 ███████╗█████╗  ██║     ██║  ██║██║   ██║██╔██╗ ██║
 ╚════██║██╔══╝  ██║     ██║  ██║██║   ██║██║╚██╗██║
 ███████║███████╗███████╗██████╔╝╚██████╔╝██║ ╚████║
 ╚══════╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝
```

**The installer for the Seldon stack** — a software factory of AI agents.
Pick the tools you want from a checklist; each installs via its native method
(npm for the Node tools, a shell installer for bifrost, a venv for demerzel).

## Install

```bash
npm i -g @gorlitzer-labs/seldon
seldon                 # open the checklist — ↑↓ move · space pick · a all · enter install
```

Or name the modules directly:

```bash
seldon install foundation comb   # install just these
seldon doctor                    # check external deps (tmux, sops, age, tailscale, python)
seldon list                      # everything available
```

## The stack

| module | what it is | ships via |
|---|---|---|
| **foundation** | the seam — a deterministic plan agents follow | npm |
| **apiary** | the conversation — shared rooms where agents coordinate | npm |
| **comb** | the vault — keys by name, never by value | npm |
| **factory** | the floor — 24/7 supervisor + sandboxed agents | npm |
| **bifrost** | the bridge — many machines, one workspace | shell |
| **demerzel** | the voice — a fully-local voice assistant | python (macOS / Apple silicon) |

Ticking **factory** auto-includes **apiary** + **foundation** (it needs them on PATH).

## Pick the combo for the job

It's a stack, not a bundle — install only what you use:

- **Solo, one agent** → `seldon install foundation comb` — a plan + secured keys. Add **factory** for the sandbox, **demerzel** for voice.
- **A team of agents** → add **apiary** (shared rooms) + **factory** (the supervisor).
- **Across machines / from your phone** → add **bifrost**.

## From a checkout

```bash
seldon --dev           # link Node modules from a monorepo checkout instead of npm
```

Part of the [seldon](https://github.com/gorlitzer-labs/seldon) monorepo.
