# Onboarding — seldon-stack

You've landed in the **Seldon stack** teardown: an interactive, `anatomy`-class
lecture that flies through a 3D honeycomb and opens each cell into a real module
TUI with real captured workflows and guided narration. This gets you productive
in ~10 minutes.

## What it is (and isn't)

- **Is:** a Vite + React-Three-Fiber single-page app. A 3D "spine" (honeycomb of
  hexes, one per tool) you navigate; each beat frames a hex and drops into that
  module's real product surface.
- **Isn't:** a video, a GSAP reel, or marketing copy. Everything shown is a real
  surface driven by real captures. It's meant to be *screen-recorded* into a
  ~4–5 min video, or explored live.
- **Everything is agnostic.** The demo thread is a made-up **Weather CLI**
  project with agents `ana` / `ben`. Never wire in a private product, room, or
  real customer data.

## Prereqs

- Node 20+ and npm.
- That's it — no env vars, no backend, no secrets. Narration is pre-rendered and
  committed under `public/vo/`.

## Get it running

```bash
npm install
npm run dev        # http://localhost:5173  — arrows to step, space to pause
npm run build && npm run preview   # verify the static bundle
```

## Layout — where things live

```
src/
  main.tsx                 app entry
  App.tsx                  composes Scene + UI overlays
  three/Scene.tsx          the 3D honeycomb, camera flights, focus/view logic
  deck/
    deck.ts                zustand store — current chapter/beat, flat stepping
    useHashRoute.ts        #/chapter/beat  <->  store sync
  content/                 *** all lecture content lives here ***
    chapters.ts            the 9 chapters and their beats (the script)
    types.ts               Beat / Chapter / SayLine / View / ModuleId
    modules.ts             per-module metadata
    captures/              real captured workflows shown in the surfaces
      apiary.json  bifrost.txt  comb.txt  factory.txt  foundation.txt
  ui/
    Story.tsx Rail.tsx Controls.tsx Syllabus.tsx  overlays
    Narrator.tsx           plays vo/{voice}/{chapter}-{beat}-{i}.mp3 + captions
    Surface.tsx            picks which module surface to render for a beat
    surfaces/              the real TUIs: Terminal, Apiary, Demerzel, Stack…
  demerzel-avatar/         the Demerzel voice avatar (vendored three)
public/vo/{george,lily}/   34 narration mp3s
```

## The content model (the part you'll edit most)

A **Chapter** has a `marker` ("00".."08"), `title`, and a list of **Beats**.
A **Beat** is one framed moment:

```ts
{
  id: "read-back",
  kicker: "Delivery confirmation",
  heading: "It reads the composer back.",
  body: ["...optional paragraphs..."],
  focus: "apiary",        // which hex the camera lifts; null = whole hive
  view: "surface",        // "hive" | "surface" | "combo"
  say: [                  // narration lines, each can re-cue the scene
    { text: "Watch the composer.", look: "apiary", view: "surface" },
  ],
}
```

### Add / change a beat
1. Edit the chapter's `beats[]` in `src/content/chapters.ts`.
2. Set `focus` + `view` so the scene knows what to show.
3. If it has narration, add `say[]` lines **and** the matching mp3s (below).

### Add narration for a beat
Files are named `public/vo/{voice}/{chapterId}-{beatId}-{i}.mp3` (`i` = 0-based
line index). Voices: `george`, `lily`. Regenerate via ElevenLabs — **the key
lives in `comb`, never in the repo or a command line**:

```bash
comb run --with ELEVENLABS_API_KEY -- <your tts script>
```

### Add a captured workflow to a surface
Drop the capture in `src/content/captures/` and reference it from the surface
component in `src/ui/surfaces/`. Keep captures agnostic (Weather CLI, `ana`/`ben`).

## Conventions & gotchas

- **Agnostic only** — no private products, rooms, keys, or real data. Ever.
- **Secrets by reference** — anything that needs a key goes through `comb run
  --with NAME`; never paste a key into a file, command, or this repo.
- **Box-drawing chars aren't in the mono web font** — surfaces wrap plain text;
  don't hand-draw 60-col ASCII boxes or mobile overflows.
- **Camera transforms** — animate with `xPercent`/`yPercent` semantics, not raw
  `x`/`y` that fight the centering translate.
- **`prefers-reduced-motion`** must stay honoured (no flights, everything at rest).
- **Git:** never push to `main` — feature branch → `gh pr create` → PR. Merges go
  through GitHub with the QA gate asserted inline.

## The stack it teaches (sibling repos)

`apiary` · `foundation` · `comb` · `factory` · `bifrost` · `demerzel` — each is
its own repo under the same org. This app is the guided tour over all six.
