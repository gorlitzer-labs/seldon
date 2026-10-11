# @gorlitzer-labs/seldon

```
 ███████╗███████╗██╗     ██████╗  ██████╗ ███╗   ██╗
 ██╔════╝██╔════╝██║     ██╔══██╗██╔═══██╗████╗  ██║
 ███████╗█████╗  ██║     ██║  ██║██║   ██║██╔██╗ ██║
 ╚════██║██╔══╝  ██║     ██║  ██║██║   ██║██║╚██╗██║
 ███████║███████╗███████╗██████╔╝╚██████╔╝██║ ╚████║
 ╚══════╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝
```

**One screen for every coding agent** — Claude Code, Codex, opencode — on every project and
machine: what is working, what needs you, what is next on the plan.

`seldon` is the panel. `seldon install` adds the optional add-ons (rooms, voice, secrets, the
plan), each via its native method (npm for the Node tools, a shell installer for bifrost, a
venv for demerzel).

## Install

```bash
pnpm add -g @gorlitzer-labs/seldon     # or: bun add -g …  ·  npm i -g …
seldon                 # the panel
seldon install         # the add-on checklist — ↑↓ move · space pick · a all · enter
```

Or name the modules directly:

```bash
seldon install foundation comb   # install just these
seldon doctor                    # check external deps (tmux, sops, age, tailscale, python)
seldon list                      # everything available
```

## The panel — `seldon`

```text
  SELDON   1 need you · 2 working · 1 idle   ● watcher  ○ voice

  ❯ stranded               plan 5 · 2 done
      ⚑ fix-save-crash             claude    needs you: permission prompt             2m
      ● smoke-harness              codex     working                                  40m
    weather                plan 2 · 0 done
      ● add-cache                  claude    working                                  12m
      ○ docs-pass                  claude    idle                                     1h

  ↑↓ move · ⏎ open · x stop · R resume · n new lane · p plan · r refresh · q quit
  U start stack · D stop stack · i install
```

Every coding agent on this machine — Claude Code, Codex, opencode — grouped by project (a
worktree counts for its main repo), most urgent first, refreshed every two seconds. `⏎` on an
agent opens it; `⏎` on a project runs `go`. Claude agents report their own state via
`claude agents --json`; Codex and opencode do after `seldon setup` (until then they read
*running*). Without a terminal
(a script, a hook, an agent's shell) the same rows are printed as plain text.

| key | does |
|---|---|
| `n` | new lane: type the task, pick `1` claude · `2` codex · `3` opencode (⏎ = claude) |
| `p` | the project's plan (`docs/QUEUE.md`); `⏎` on an item starts a lane on it, `a` adds one |
| `⏎` | on an agent: open it · on a project: `seldon go` |
| `x` `x` | stop the agent (asks twice) |
| `R` | resume what a reboot stopped; on a project, all of its stopped lanes |

Every lane gets its own branch and worktree. Claude lanes run as `claude --bg -w <slug>`, so
they live under Claude's own supervisor and show in `claude agents` too. Codex and opencode
lanes run in tmux (`seldon_<slug>`), in a worktree under `~/.seldon/worktrees/`, and are
recorded in `~/.seldon/lanes.json`. A plan item shows the lane working on it.

## Lanes from the command line

```bash
seldon lanes [--json]                                     # every agent here
seldon lane start [dir] --task "fix the save crash" [--agent codex]
seldon lane stop|resume|open <name or key>
```

## Codex and opencode: let them report their state

Claude Code lists its own sessions. Codex and opencode do not, so out of the box their lanes
read *running*. One command teaches them to say what they are doing:

```bash
seldon setup            # both, if installed   ·   seldon setup codex | opencode   ·   --remove
```

- **Codex:** adds command hooks to `~/.codex/hooks.json` (yours are kept). Codex runs a hook
  only after you trust it, so open `codex` once, run `/hooks` and trust the seldon ones.
- **opencode:** installs a small plugin at `~/.config/opencode/plugins/seldon.js` that forwards
  only the state events (busy / idle / permission asked / error).

Both call `seldon report <harness>`, which keeps one tiny state file per session in
`~/.seldon/state/`. The panel matches it to the lane by worktree, so a Codex lane waiting on an
approval shows **needs you: permission: Bash**, and the watcher tells you.

## The watcher — `seldon watch`

`seldon up` starts it; `seldon down` stops it. Every 5 seconds it reads the same lanes the
panel shows and sends a desktop notification **once** when an agent starts waiting on you,
fails, or finishes a piece of work. It is plain code: no tokens, and it never types into an
agent or posts into a room. `seldon watch` runs it in the foreground (`--interval 2s`,
`--once`).

## After a reboot

Claude lanes come back with Claude's own supervisor. A Codex or opencode lane whose tmux
session is gone (and that you did not stop with `x x`) shows as **stopped**; `R` on it brings
it back, and `R` on a project brings back all of its stopped lanes:

- Claude: `claude respawn` — the same conversation.
- Codex: `codex resume --last` in the lane's own worktree — the same conversation (Codex scopes
  `--last` to the directory, and every lane has its own).
- opencode: a new conversation on the same task in the same worktree; the work on disk is kept.
  (Its "continue" is per project and could pick up a sibling lane's conversation.)

## Other machines

The panel shows the agents on your other computers too, under `project @machine`, and every
key works on them: open, stop, resume, new lane, plan.

```bash
seldon machines add mini you@mini.tailnet.ts.net   # once (needs seldon there + ssh keys)
seldon machines                                    # each one, and whether it answers
```

- **The list:** machines are bifrost's realms (`~/.config/bifrost/realms/`), so bifrost,
  factory and seldon share one list.
- **How it reaches them:** the panel runs `ssh <machine> seldon lanes --json` in the background
  every 10 seconds, so a sleeping machine never freezes it, and it acts with
  `ssh <machine> seldon lane <verb> <key>`.
- **From a phone:** `ssh` to any one machine and run `seldon`. Below 70 columns it switches to
  one line per lane.

## Holds — taking turns on shared things

Agents on different projects share one machine: one boots the Android emulator, another
opens Unreal, and they trip over each other. A **hold** is turn-taking for that:

```bash
seldon hold emulator          # yours, or wait your turn (90s, then exit 2: "held by stranded/fix-save")
seldon release emulator       # done
seldon hold unreal -- ./build.sh   # hold, run, release
seldon holds                  # who holds what
```

- **Ownership:** a hold belongs to the agent process that took it (the `claude` / `codex` /
  `opencode` above the shell).
- **Expiry:** it ends when the agent exits, or after `--for` (30m default; ask again to renew),
  so a crashed agent never blocks anyone.
- **Release:** only the holder can release it. `--force` exists for a hold that is truly stuck.
- **The panel:** shows current holds at the top.

Tell your agents once, in `~/.claude/CLAUDE.md` / `AGENTS.md`:

```markdown
## Shared machine resources
Before using the Android emulator, Unreal Editor or the GPU, run `seldon hold emulator`
(or `unreal`, `gpu`). Exit 2 means another agent has it: do other work and try again later.
Run `seldon release <name>` as soon as you are done.
```

## If something's off

| you see | do this |
|---|---|
| `seldon: command not found` in a new or SSH shell | the package manager's bin folder isn't on PATH there. it's `$(npm prefix -g)/bin` for npm, `$PNPM_HOME` for pnpm. Add that folder to PATH in `~/.zshrc` |
| `factory: command not found`, but `seldon` works | nothing to fix — `seldon go` and the panel prepend their own install folder, so the siblings resolve even in a non-interactive shell |
| you joined a room and you are alone in it | opening a room never staffs it. `seldon go` does both; or `factory staff <project>` |
| an old version answers, or two copies | `seldon install <tool>`. It leaves exactly one copy and says which one it removed |
| `seldon uninstall` says *still installed under …* | that exact path is left; delete it, then run the uninstall again |
| pnpm: *global bin directory … is not in PATH* | two pnpm versions on one machine. `seldon install` / `uninstall` handle it; avoid running `pnpm rm -g` by hand |
| Cursor / an app can't start `apiary mcp` | apps don't get your shell's PATH. Use absolute paths ([how](modules/apiary/README.md#mcp-server-apiary-mcp)) |
| an MCP agent's `catch_up` always says *nothing new* | apiary older than 1.13.9. Run `seldon install apiary` |

## With rooms: `seldon go` (apiary + factory add-ons)

The one verb. Run it inside a repo and it fills in whatever is missing, in order, then hands
you a seat in the room:

```bash
seldon go                     # this repo
seldon go stranded            # by project name, from anywhere
seldon go --agent codex       # a Codex agent rather than Claude
seldon go --no-staff          # open the room, start nobody
seldon go --no-attach         # do everything, leave the terminal alone
seldon go --attach            # attach even with no terminal detected (inside tmux, a script)
```

```text
  stranded  /Users/you/Desktop/stranded
  ✓ adopted            (foundation docs in place)
  ✓ hive up            http://127.0.0.1:7920
  ✓ supervisor running
  → nobody is working here — staffing
    queue 5 · 2 done · 2 lanes
    next: (P1) automate the playtest checklist in the smoke harness…
  → attaching to the stranded room
```

`✓` is a step it skipped because it was already true, `→` one it did. The five steps are:
**adopted?** → **room up?** → **supervisor?** → **anyone working?** → **attach**. Each is
idempotent, so `go` is safe on a cold boot, twice in a row, or mid-session.

It owns no state of its own: it asks `factory state` what is missing and delegates every
action to `factory adopt`, `factory staff` and `apiary room resume`. The reason it exists is
that those four commands live in three tools and **none of them answered the whole question**
— so an adopted repo whose room had stopped looked exactly like a broken install.

Two things it fixes that bit repeatedly:

- **Opening a room does not staff it.** `factory adopt` leaves an *empty* room, so you joined
  and sat there alone. `go` staffs before it attaches, and the panel flags "work queued,
  nobody working" as needing you.
- **Siblings resolve.** `go` and the panel prepend seldon's own install folder to `PATH`, so
  `factory: command not found` stops happening in non-interactive shells.

## Start the stack

One command brings up the always-on services and prints where to go:

```bash
seldon up            # starts the voice (demerzel) + the supervisor (factory watch),
                     # then prints: Voice → http://localhost:8770, how to put agents
                     # to work, rooms, phone access
seldon up --tailnet  # also expose the voice on your tailnet → reach it from your phone
seldon status        # what's running (pids) — and warns if docker's daemon is down
seldon adopt [dir]   # put an existing repo on the line (foundation · hive · supervised)
                     # and print what's next from its queue. Safe to re-run.
seldon down          # stop everything
```

**Voice brain (Qwen or Bonsai):** the first `seldon up` after installing the voice
asks once — **q** for Qwen 3.6-35B (in-process, sharpest, ~20 GB) or **b** for
Bonsai 2-27B (a local llama-server, lighter ~7 GB, tool-capable) — and remembers
the choice. Switch anytime with `seldon up --brain=qwen|bonsai`. When you pick
Bonsai, seldon fetches its runtime + model (~7 GB, macOS/Apple-silicon) and runs
the server as a managed daemon; `seldon status` shows the active brain, `seldon
down` stops it.

**Phone access:** `seldon up --tailnet` serves the voice over **HTTPS** on your
tailnet (via `tailscale serve`) and prints a `https://<machine>.<tailnet>.ts.net`
URL — open it on your phone and the **mic works** (browsers require HTTPS for the
microphone; plain http can't). The default `seldon up` stays loopback-only, and
the Mac's own `http://localhost:8770` already works (localhost is a secure context).

Needs **HTTPS Certificates enabled** for your tailnet — one toggle at
[login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) → *HTTPS
Certificates*; `--tailnet` tells you if it isn't. The serve config persists across
reboots. Since Demerzel can act on the host, anyone on your tailnet can talk to it
— use `DEMERZEL_READONLY=1` when sharing.

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

Node tools are removed from **every** global store that has them (npm, each pnpm
on PATH — Homebrew's and corepack's can both be there — bun, and a copy loose
next to node), one package at a time. Each is checked afterwards: "removed"
means the files are gone, not that a command exited 0. Already gone counts as
success; anything still there is named with its path and the command exits 1.
demerzel's isolated venv and bifrost's binary + config are deleted. Your system
Python, tmux, tailscale, sops/age, and your comb vault (`~/.comb`) are never
touched. seldon itself stays; the last line tells you how to remove it too.

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

Node tools install with **the package manager that installed seldon itself**, so
`npm i -g @gorlitzer-labs/seldon` gives you an all-npm stack and `pnpm add -g …`
an all-pnpm one. Force one with `--pm=pnpm|npm|bun`.

Install leaves **exactly one copy** of each tool: if an older one sits under a
different package manager (a second pnpm, npm, or loose next to node), it is
removed, and the installer says so. Two copies is how a stale tool keeps
answering after you upgraded.

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
