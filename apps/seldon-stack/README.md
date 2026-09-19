# seldon-stack

An interactive, anatomy-class teardown of **the Seldon stack** — a software
factory of AI agents that runs the plan and wakes you only for the pivotal calls.

Not a slide deck and not a reading. You fly through a 3D honeycomb "spine," and
each cell opens into one module's **real product surface** (its actual TUI),
driven by **real captured workflows**, with **guided narration** over the top —
the way `anatomy` tears down a computer.

Live surfaces, real captures, one demo thread (an agnostic **Weather CLI**
project, agents `ana` / `ben`) — nothing from any private product.

## The six tools it teaches

| # | module | role | what it holds up |
|---|---|---|---|
| 01 | **apiary** | the conversation | shared rooms where AI agents talk, coordinate, hand off |
| 02 | **foundation** | the seam | the deterministic project workflow beneath it all |
| 03 | **comb** | the vault | keys by name; a leak audit; multi-machine secrets (SOPS + age) |
| 04 | **factory** | the floor | the 24/7 supervisor — `new · watch · board · box · realms` |
| 05 | **bifrost** | the bridge | tmux + Tailscale; sessions survive; phone access; agent state |
| 06 | **Demerzel** | the voice | a fully-local voice you talk to |

## How it's built

- **React 19.2** + **@react-three/fiber** / **drei** + **three 0.185** — the 3D hive and camera flights
- **zustand** — the deck store (chapters → beats, focus + view)
- **Vite** — dev server and static build
- Hash routing (`#/chapter/beat`), so every beat is a shareable, reloadable URL
- Narration: pre-rendered ElevenLabs voice-over (`george`, `lily`) under `public/vo/`

### Content model

Nine chapters (`00` intro → `06` modules → `07` combos → `08` credits). Each
chapter is a list of **beats** (subchapters); a beat frames or lifts one hex,
picks a **view** (`hive` · `surface` · `combo`), and carries the narration lines.
All content lives in `src/content/` — see [ONBOARDING.md](./ONBOARDING.md) for the
map and how to add a chapter, beat, capture, or voice line.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # → dist/  (static, host anywhere)
npm run preview    # serve the built dist/ locally
```

Drive it by hand: **← →** step beats · **space** pause · the syllabus rail jumps
chapters. Honours `prefers-reduced-motion` (everything settles at rest, no flight).

## Deploy

`npm run build` emits a fully static `dist/` — drop it on any static host
(Pages, a bucket, the home cluster). No server, no env vars at runtime; the
narration mp3s ship in the bundle. CI/deploy isn't wired yet — it's dev-server
and manual `dist/` today.
