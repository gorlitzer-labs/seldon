# @gorlitzer-labs/seldon

The installer for **the Seldon stack**. Pick the tools you want from a checklist;
each installs via its native method (npm for the node tools, the shell installer
for bifrost, a venv for demerzel).

```bash
npm i -g @gorlitzer-labs/seldon
seldon                 # open the checklist — space to pick, enter to install
seldon install factory # or install named modules (pulls in apiary + foundation)
seldon doctor          # check external deps (tmux, sops, age, tailscale, python)
seldon list
seldon --dev           # link node modules from a monorepo checkout instead of npm
```

Modules: `apiary` · `foundation` · `comb` · `factory` · `bifrost` · `demerzel`.
Ticking `factory` auto-includes `apiary` + `foundation` (it needs them on PATH).
`demerzel` is offered only on macOS / Apple silicon.
