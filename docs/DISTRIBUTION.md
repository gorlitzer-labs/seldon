# Distribution — how the Seldon stack ships

One repo, one clone. But each tool stays independently installable — apiary's
model, applied to all of them — with a single installer on top so you pick what
you use.

## The shape

- **Monorepo = npm workspaces.** `modules/{apiary,foundation,comb,factory}` are
  independently-versioned, independently-published npm packages. `tools/seldon`
  is the installer. `apps/seldon-stack` is the teardown. `modules/{bifrost,
  demerzel}` are non-node (shell / python) and install via their native path.
- **Registry: public npm under `@gorlitzer-labs`.** apiary used to publish to
  GitHub Packages (restricted) — moved to public npmjs so `npm i -g` needs no
  auth. `comb` was renamed `@gorlitzer-labs/comb` for scope consistency.

## The installer — `@gorlitzer-labs/seldon`

Zero-dependency raw-terminal checklist (no build step, no React).

```bash
npm i -g @gorlitzer-labs/seldon
seldon                 # checklist: ↑↓ move · space toggle · a all · enter · q
seldon install factory # named modules (auto-includes apiary + foundation)
seldon doctor          # external deps: tmux, sops, age, tailscale, python3
seldon --dev           # link node modules from a checkout instead of npm
```

Install methods per module:

| module | method | how |
|---|---|---|
| apiary, foundation, comb, factory | npm | `npm i -g @gorlitzer-labs/<m>` (or `npm link` in `--dev`) |
| bifrost | shell | runs `modules/bifrost/install.sh` (fetched from this repo) |
| demerzel | python | clone + venv + `pip install -r requirements.txt` (macOS/Apple-silicon only) |

Rules the installer enforces: **requires** (factory → apiary + foundation),
**platform gating** (demerzel), and a **preflight doctor** that flags missing
external deps with the `brew install …` line before it starts.

## Publishing

`npm run publish:all` (root) publishes the node packages in dependency order
(apiary + foundation before factory), public access. Prerequisite: an npmjs org
`@gorlitzer-labs` and `npm login`. `--dry-run` is supported.

## Retiring the standalone repos

Once published + `seldon install` is verified, the seven standalone repos are
deleted — history is already preserved in this monorepo (subtree import, merge
commit). bifrost's `install.sh` was repointed from `gorlitzer-labs/bifrost` to
this monorepo (`main`, `modules/bifrost/`) so it survives the deletion.

## Open follow-ups

- Per-module CI lives in `modules/*/.github` and won't run from a subdir — move
  the needed workflows (esp. apiary's publish) to root before relying on CI.
- The seldon-stack teardown gets an "install the stack" beat once the real
  `seldon install` TUI can be captured (keep it real; one VO pass then).
