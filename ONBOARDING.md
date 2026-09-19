# Onboarding — the Seldon stack

Welcome to the front door of **Seldon**: a software factory of AI agents made of
six tools you can pick from, plus an interactive teardown that teaches them. This
gets you oriented in ~15 minutes. You don't need all six to start — begin with
one and add the rest as you feel the gaps.

## The mental model

- **You** set direction and get woken only for the calls that matter.
- **factory** is the 24/7 supervisor on the floor — it spins agents, boxes them
  (permissions skipped *inside a container*, host sealed), and runs the board.
- **apiary** is where those agents talk — shared rooms, hand-offs, status.
- **foundation** is the deterministic workflow each agent follows (plan → build → verify).
- **comb** hands out secrets by name so keys never touch code or transcripts.
- **bifrost** stretches all of it across machines (tmux + Tailscale) and to your phone.
- **Demerzel** is the local voice you talk to when you don't want a keyboard.

The gaps each one closes (learned the hard way, don't re-litigate):
delivery is confirmed, not assumed; you **containerize the work, not the agent**;
a better tmux was the wrong lever — bifrost *composes* tmux instead of replacing it.

## Try the stack in the order that teaches it

Every module has its own README + ONBOARDING; the fastest tour is the
[seldon-stack](apps/seldon-stack) 3D teardown. To
get hands-on, go module by module:

1. **apiary** — spin a room, drop two agents in it, watch them coordinate.
2. **foundation** — bootstrap a project so agents have a deterministic workflow.
3. **comb** — `comb init`, add a key, prove `comb run --with NAME` injects it and
   the transcript audit catches a leak.
4. **factory** — `factory new` a boxed run, `factory board` to watch it.
5. **bifrost** — attach from a second machine and from your phone; watch the
   agent-state glyphs (● idle / ◐ working / ■ needs-you).
6. **Demerzel** — talk to it locally end to end.

Then read [docs/end-to-end.md](docs/end-to-end.md) — one real run threaded
through all six.

## Ground rules (apply everywhere in the stack)

- **Secrets by reference only.** `comb run --with NAME -- <cmd>`. Never paste a
  key into a file, a command, or a chat. If one leaks, rotate it.
- **Agnostic examples.** Weather CLI, agents `ana` / `ben`. No real product,
  room, or customer data in docs or demos.
- **Git:** never push to `main` — feature branch → `gh pr create` → PR. Merges go
  through GitHub with the QA gate asserted inline. Two identities on this machine
  (`gorlitzer` default; `LegendFrancesco-Berardi` only under `~/legend/`).

## Where to go next

- The interactive teardown: [seldon-stack](apps/seldon-stack)
- The full run: [docs/end-to-end.md](docs/end-to-end.md)
- Any single tool: its repo (see the table in [README.md](README.md))
