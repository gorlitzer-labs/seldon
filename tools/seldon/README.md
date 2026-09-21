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
pnpm add -g @gorlitzer-labs/seldon     # or: bun add -g …  ·  npm i -g …
seldon                 # open the checklist — ↑↓ move · space pick · a all · enter install
```

Or name the modules directly:

```bash
seldon install foundation comb   # install just these
seldon doctor                    # check external deps (tmux, sops, age, tailscale, python)
seldon list                      # everything available
```

## Start the stack

One command brings up the always-on services and prints where to go:

```bash
seldon up            # starts the voice (demerzel) + the supervisor (factory watch),
                     # then prints: Voice → http://localhost:8770, how to put agents
                     # to work, rooms, phone access
seldon up --tailnet  # also expose the voice on your tailnet → reach it from your phone
seldon status        # what's running (pids)
seldon down          # stop everything
```

**Voice brain (Qwen or Bonsai):** the first `seldon up` after installing the voice
asks once — **q** for Qwen 3.6-35B (in-process, sharpest, ~20 GB) or **b** for
Bonsai 2-27B (a local llama-server, lighter ~7 GB, tool-capable) — and remembers
the choice. Switch anytime with `seldon up --brain=qwen|bonsai`. When you pick
Bonsai, seldon fetches its runtime + model (~7 GB, macOS/Apple-silicon) and runs
the server as a managed daemon; `seldon status` shows the active brain, `seldon
down` stops it.

**Phone access:** `seldon up --tailnet` binds the voice to this machine's Tailscale
IP and prints `http://<tailnet-ip>:8770` — open it on any device on your tailnet.
The default `seldon up` stays loopback-only. Since Demerzel can act on the host,
exposing it means anyone on your tailnet can talk to it — run with
`DEMERZEL_READONLY=1` when sharing.

> **Mic needs HTTPS.** Browsers only allow the microphone in a *secure context*
> (HTTPS or localhost). The `http://<tailnet-ip>` URL loads on a phone but the
> mic stays blocked. To talk from a phone, front the voice with HTTPS — e.g.
> `tailscale serve` (Tailscale HTTPS must be enabled for your tailnet), which
> gives a `https://<machine>.<tailnet>.ts.net` URL with a real cert. On the Mac
> itself, `http://localhost:8770` is a secure context, so the mic works there.

`seldon up` only starts what's installed. demerzel serves the voice UI on
`http://localhost:8770`. Its model set (~25 GB) is a one-time download —
`seldon install demerzel` **offers to fetch it right there** ([y/N]), and `seldon up`
offers again if it's still missing. Nothing that big is ever pulled silently.
Logs live in `~/.seldon/run/`.

**Swap the in-process Qwen model:** set `DEMERZEL_LLM` to any MLX-compatible HF
repo before install/up — the fetch and the runtime both follow it (this only
changes the *Qwen brain*; for Bonsai use `--brain=bonsai` above, which is a
separate llama-server, not an MLX repo).

```bash
DEMERZEL_LLM=mlx-community/<some-mlx-repo> seldon up
```

## Uninstall

```bash
seldon uninstall comb demerzel   # remove specific modules (asks to confirm)
seldon uninstall --all           # remove the whole stack (also drops ~/.seldon)
seldon uninstall <ids> --yes     # skip the confirm prompt
```

Node tools are removed from the global store; demerzel's isolated venv and
bifrost's binary + config are deleted. Your system Python, tmux, tailscale,
sops/age are never touched.

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

## Package managers

Node tools install with **pnpm** when it can global-install (much faster than npm),
else **npm**. **bun** is supported but opt-in — `seldon install --pm=bun` (also
`--pm=pnpm|npm` to force any of them).

demerzel (Python) always installs into its **own isolated venv** — never your
system or active Python. It pins **CPython 3.12** (its `kokoro` pin caps Python at
`<3.13`) and uses **uv** to provision a standalone 3.12: if `uv` isn't present,
seldon bootstraps it into `~/.seldon/bin` with no shell/PATH changes. If uv can't
be installed, it falls back to a matching `python3.12` on PATH.

## From a checkout

```bash
seldon --dev           # link Node modules from a monorepo checkout instead of npm
```

Part of the [seldon](https://github.com/gorlitzer-labs/seldon) monorepo.
