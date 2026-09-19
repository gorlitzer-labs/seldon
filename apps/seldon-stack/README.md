# seldon-stack

The pitch reel for **Seldon** — a software factory of AI agents that runs the
plan and wakes you only for the pivotal calls.

An auto-playing, GSAP-driven keynote: the six tools, what each one holds up, what
breaks when you pull one, one run end to end, and the measurement that set the
architecture. Built to be screen-recorded into a ~4½-minute video.

## The stack it pitches

| module | role | |
|---|---|---|
| **apiary** | the conversation | shared rooms for AI agents |
| **bifrost** | the bridge | tmux + Tailscale; sessions survive; phone access; agent state |
| **factory** | the floor | the 24/7 supervisor — new · watch · board · box · realms |
| **comb** | the vault | keys by name; a leak audit; multi-machine secrets |
| **foundation** | the seam | the deterministic project workflow beneath it all |
| **Demerzel** | the voice | a fully-local voice you talk to |

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # → dist/  (static, host anywhere)
```

Drive it by hand with **← →**, **space** to pause, the dots, or the buttons.
Honours `prefers-reduced-motion` (no motion, everything at rest).

## Recording the video

Press **▶**, go full-screen, and screen-record. The reel runs itself start to
finish in about four and a half minutes.

Built with [GSAP](https://gsap.com) + [Vite](https://vitejs.dev). MIT.
