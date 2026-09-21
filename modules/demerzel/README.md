# demerzel

**the voice** — a fully-local voice assistant. You say her name, she
listens, she answers, she does things. Nothing leaves the machine — no API key,
no cloud STT, no telemetry, verified with `lsof`, not with a promise.

Built on an M3 Pro / 36 GB. Roughly **2 seconds** from your last word to her
first word, with a 35B model doing the thinking.

---

## TL;DR — the stack

| Layer | What | Why |
|---|---|---|
| **Brain** | `Qwen3.6-35B-A3B-4bit` via **MLX** | MoE, 3B active. Non-negotiable: this machine has 150 GB/s bandwidth, so a dense 27B would read ~16 GB per token and never keep the speech fed. Decodes at **52 tok/s**. |
| **Ears** | `Qwen3-ASR-1.7B-8bit` via **mlx-audio**, with hotword biasing | Chosen for accented English (16.07 WER vs Whisper large-v3's 21.30 on dialog-accented). Hotwords are what make domain vocabulary come out right. `DEMERZEL_STT=parakeet` swaps in Parakeet TDT v3 — ~190 ms faster, worse vocabulary. |
| **Mouth** | `Kokoro-82M` via **PyTorch/MPS** | The MLX port emits NaN. PyTorch it is. |
| **Endpointing** | **Silero VAD**, 576 ms hangover | Smart Turn v3 is built but not wired — see *Not done yet*. |
| **Who's talking** | **CAM++** `en_voxceleb`, ONNX on CPU | 29.6 MB. A filter, not a credential — see *Voices*. |
| **Echo cancellation** | The **browser** | `getUserMedia({echoCancellation:true})` measured **26.8 dB ERLE** on this Mac over speakers. That is the entire reason there is no CoreAudio binding in this repo. |
| **Transport** | websockets + a static file server, loopback only | `ws://127.0.0.1:8765`, UI on `http://127.0.0.1:8770`. |
| **Front end** | Vanilla JS + vendored **three.js** | No build step, no CDN. `web/vendor/` is checked in. |
| **Extensibility** | An **MCP client**, as a skill | Any MCP server becomes a capability. Nothing enabled by default. |

Python 3.12 (its `kokoro` pin caps Python at `<3.13`). About 4,500 lines. No
framework — no LangChain, no pipecat, no livekit. The pipeline is short enough to
read in an afternoon.

---

## Local-first, and what that actually means here

"Local" is easy to claim and easy to get wrong. What we did:

- **Every model resolves from the on-disk HF cache.** One stray
  `huggingface.co` connection at boot was found and removed.
- **`scripts/check-offline.sh`** inspects the running server's open sockets
  with `lsof` and fails if a single one is not loopback.
- **The MCP client ships with everything disabled.** Each server in
  `~/.demerzel/mcp.json` declares whether it can reach the network, and you turn
  it on by hand. Every MCP tool is treated as a *write*, because she cannot know
  whether a remote tool mutates something and guessing permissively would let a
  guest act through it.
- **She has no search and no news, on purpose.** She says "I have no internet"
  rather than inventing a headline. Adding search means choosing a tier
  (self-hosted SearXNG vs a provider API that sees your queries), and that
  choice is deliberately still open.

Sharing over a tailnet is possible (`DEMERZEL_READONLY=1`) but voids the
loopback-only guarantee — your microphone audio crosses the tailnet. It is
called out in the queue rather than quietly allowed.

---

## The UI

Three surfaces, not one page:

- **A console fixed to the viewport** — instrument, log, rail. It never
  scrolls. An earlier version stacked everything into one tall page with the
  avatar cut off the top.
- **A native `<dialog>` for anything that is an ACTION** (enrol a voice, manage
  the roster).
- **Toasts for anything that is a STATUS** (reconnecting, model loaded, busy).

Details that took more than one attempt:

- **The avatar is a reactive core, not a humanoid.** The first three versions
  were a figure, borrowed uncritically from the build that inspired this. A
  mannequin at low fidelity reads as uncanny and represents nothing about a
  voice. It is now an iris that dilates with attention, a two-sided spectrum
  ring (her voice and yours, live), orbital rings and a tick scale — every
  element driven by real state or real audio, none of it decorative.
- **WebGL clamps line width to 1 physical pixel** on essentially every
  platform, and `LineBasicMaterial.linewidth` is silently ignored. At DPR 2
  those hairlines antialias into a grey smear. That is why three successive
  avatars looked washed out regardless of colour tuning. Every visible element
  is now a real mesh, so stroke weight is real.
- **One button system.** Every clickable is `.btn` plus at most one modifier.
  No id-based or element-based button styling remains anywhere.
- **Each enrolled person gets a colour**, assigned server-side at enrolment by
  round-robin over unused palette entries and stored in the profile. Hashing
  the name client-side was tried first and put two people on the same hue.
- Two CSS bugs worth knowing: a media query carries no extra specificity, so a
  later base rule with the same selector silently wins; and
  `justify-content:flex-end` on a scrollable flex container clips overflow at
  the *start* edge unreachably (`scrollHeight == clientHeight` while the
  earliest children sit above the top). Bottom-anchor with `margin-top:auto`
  instead.

Both layouts are verified headlessly: the page does not scroll, and the newest
log line is never clipped.

---

## ⚠️ This is coupled to a private stack — you will need to adapt it

Demerzel is the voice of **[factory / foundation / apiary](https://github.com/gorlitzer-labs)**,
Franko's own agent-orchestration tooling. That coupling is real, but it is
contained in a few named places rather than smeared through the pipeline:

| What | Where | To adapt |
|---|---|---|
| Factory skill — read the board, queue work, create a project, staff a hive | `demerzel/skills/factory.py` | Delete the module. The registry keeps working; you lose 6 tools of 19. |
| Escalation watcher — she speaks up unprompted when a hive is blocked | `demerzel/factory.py` | Same: drop it, or point it at your own state source. |
| `docs/` is a **Foundation seam** (`QUEUE`, `WORKSTREAMS`, `DONE`, `FACTS`) | `docs/` | Those files are never hand-edited; every mutation goes through a `foundation` command. Without the CLI they are still readable Markdown — `docs/FACTS.md` is the interesting one. |
| Hotwords, system prompt, file roots | `demerzel/models.py`, `demerzel/skills/files.py` | Franko's vocabulary and name are hardcoded. Change them. |

**The point of the skills layer is exactly this.** `demerzel/tools.py` holds only
the mechanism — the `Tool` dataclass, the registry, the call format, narrated
execution. Every capability is a module under `demerzel/skills/` that registers
into it. The factory is *one skill*, not what she is. Adding MCP later was a new
module, not a rewrite.

---

## How a turn works

```
browser mic (AEC, 48k)  →  16k  →  Silero VAD  →  endpoint
   →  Qwen3-ASR (buffered utterance, batch decode)   ~304 ms
   →  attention gate: is the window open? is this a known voice?
   →  Qwen3.6-35B, retained KV cache                 ~445 ms to first token
   →  clause splitter  →  Kokoro per clause          ~395 ms to first audio
   →  websocket audio frames  →  browser playback
```

Measured, steady state: **~1.4 s from the endpoint decision to first audio**,
plus the **576 ms VAD hangover** ≈ **1.96 s from your last word**. That last
number is the honest one; measuring from the endpoint instead is how latency
claims get flattering.

### Things that cost real time to learn

- **GPU buffer eviction between frameworks.** Whichever of MLX and PyTorch/MPS
  touched the GPU last evicts the other's buffers, and the evicted one pays
  ~1.1 s on its next call. The first turn was 1365 ms against a 330 ms steady
  state. The original "cold KV cache" diagnosis was **wrong** — prefilling the
  system prompt changed nothing under control. Fixed by warming the LLM *last*
  and running two settle turns at boot.
- **Pinning MLX wired memory** (`mx.set_wired_limit`) took the first generation
  with three models resident from 3268 ms to 347 ms.
- **The wired cap is 60% of RAM, and there is a PID lock.** Two processes each
  asking for 24 GB of non-pageable memory on a 36 GB machine with no swap hung
  the Mac hard enough to need a power cycle. The lock is the real fix; the cap
  is the second seatbelt.
- **A retained KV cache is not optional.** Uncached TTFT *grows* with
  conversation length (417 → 703 ms over four turns); cached stays flat
  (385 → 328).
- **Kokoro's first-audio cost tracks audio duration, not text.** G2P is 2 ms —
  0% of the total. RTF ≈ 0.23, so the lever is a *shorter spoken opener*, not a
  faster phonemizer. Benchmarks must use varied text: the same string measured
  1203 ms cold and 134 ms on repeat, which is phonemization caching, not warm
  GPU state.
- **Streaming ASR was a dead end at utterance scale.** On a 1.86 s clip,
  320/480/640 ms chunks returned empty strings and 960 ms returned "Yeah.",
  while one whole-clip call transcribed correctly.

`docs/FACTS.md` has all of these with their verification commands and dates.
Nothing in there is a claim without a `verified:` line.

---

## Attention: a name opens a conversation, not a turn

Saying "Demerzel" opens a **window**, not a single exchange. For 25 s afterwards
follow-ups need no wake word, and every completed turn extends it. "That's all"
closes it; "stay with me" removes the timeout. An announcement *she* initiates
also opens the window, so replying to her own escalation needs no wake word.

Two bugs worth stealing the fixes for:

- **The window must measure her silence, not yours.** Extending it when a turn
  *started* meant a twenty-second answer ate its own window, and the next two
  sentences were logged "overheard | not addressed". `touch()` now fires when a
  turn *finishes*.
- **Dismissal must be a tool, not a regex.** She said "Understood, I will not
  listen" and kept listening. The model understood every phrasing — including
  Italian — but the window was only closed by a keyword regex that matched none
  of them. Comprehension was never wired to state. She now has a
  `stop_listening` tool, so any wording in any language works.

There is no acoustic wake word: openWakeWord ships no model for "demerzel", and a
custom one is hours of synthesis for uncertain recall. Since every utterance is
transcribed anyway, the trigger is her name in the *transcript*.
`Attention.wake_detected` is the seam to swap an acoustic model in behind.

---

## Voices

Multiple named voiceprints with roles, in `~/.demerzel/voices.json`. Enrolment is
open-set, so an unenrolled speaker comes back as *nobody* rather than the
nearest profile.

**Speaker verification here is a filter, not a credential.** CAM++ separates the
enrolled voice well from most others (0.903 vs 0.067 / 0.099 / 0.195), but
another American female voice scored 0.648 and would have passed the original
0.58 write threshold, while enrolment self-similarity bottomed at 0.769 — a
margin of only ~0.12. So: thresholds raised to 0.45 converse / 0.72 write, and a
voice is *never* authorisation for an irreversible write. The spoken confirm
gate stays regardless.

The first voice enrolled becomes the owner; a recognised guest can converse
freely but cannot answer a factory decision or change her memory. **Nobody
enrolled means she answers everyone** — a voiceprint is opt-in, and failing
closed would silently mute her before you could enrol. The UI shows an
"anyone can talk" chip so that state is visible rather than surprising.

---

## Tools

19, across six skills. Each declares a **spoken present-tense intent said before
it runs**, plus a 30 s heartbeat while it runs, because some of them shell out
through `npx` and take 5+ seconds — silence for five seconds reads as a hang.

```
factory    board · projects · project_status · queue_work · new_project · start_coordinator
files      read_file · find_files
system     time_now · battery · now_playing · get_volume · set_volume · open_app · lock_screen
timers     set_timer · list_timers · cancel_timers
attention  stop_listening
mcp        (whatever the enabled servers expose, prefixed and marked)
```

Guards that exist because they had to:

- **Identical `(name, args)` calls within one turn do not repeat.** She called
  `new_project` twice while thrashing, which would have created a repository
  twice.
- **Writes are owner-only and gated behind a spoken confirmation.**
  `start_coordinator` starts a real agent session that writes code and, on a
  cloud harness, costs money. An ambiguous reply re-prompts.
- **Never break generation at `<tool_call>`.** Truncating there means the call
  never parses and she says nothing at all. Stop *speaking* when a call starts,
  keep *generating*.
- **Check a GUI app is alive before asking it questions.** `osascript` against a
  non-running app measured 8 seconds, because macOS may try to launch it.
  `pgrep` first costs 35 ms.

---

## Running it

Needs Apple Silicon with ≥ 36 GB. She holds ~21.5 GB resident.

**The easy path — via the seldon installer** (recommended). It provisions an
**isolated CPython 3.12 venv** at `~/.seldon/demerzel/.venv` using `uv` (auto-installed
into `~/.seldon/bin` if missing) — your system/active Python is never touched:

```bash
seldon install demerzel            # offers the one-time model fetch (~25 GB)
seldon up                          # starts the voice on http://localhost:8770
                                   # (add --tailnet for your phone; --brain=bonsai for the Bonsai brain)
```

**Or by hand**, from a checkout — use Python 3.12 (not 3.13; `kokoro` requires `<3.13`):

```bash
uv venv .venv --python 3.12 && source .venv/bin/activate   # or: python3.12 -m venv .venv
uv pip install -r requirements.txt                          # or: pip install -r requirements.txt
python scripts/fetch-models.py     # ~25 GB, resumable
python -m demerzel.server            # then open http://localhost:8770
```

Press **listen**, allow the microphone, say her name.

```bash
python scripts/smoke.py            # one full turn, end to end
./scripts/check-offline.sh         # every socket the running server holds is loopback
python scripts/enroll.py           # enrol a voice from the CLI
```

Do not run a benchmark while the server is up. The PID lock will refuse, and
that refusal is load-bearing.

### Environment

| Variable | Default | |
|---|---|---|
| `DEMERZEL_BRAIN` | `qwen` | `bonsai` runs the brain as a local OpenAI-compatible server (Bonsai 2 via llama.cpp) instead of the in-process Qwen — lighter (~7 GB vs ~20 GB). Managed for you by `seldon up --brain=bonsai`. |
| `DEMERZEL_LLM_SERVER` | `http://127.0.0.1:8081` | where the brain server lives when `DEMERZEL_BRAIN=bonsai`. |
| `DEMERZEL_LLM` | `mlx-community/Qwen3.6-35B-A3B-4bit` | swaps the in-process **Qwen** MLX model (only when brain=qwen); any MLX-compatible HF repo. |
| `DEMERZEL_STT` | `qwen` | `parakeet` to A/B for speed over vocabulary |
| `DEMERZEL_READONLY` | off | disables all writes; set this before sharing a session |
| `DEMERZEL_FILE_ROOTS` | `~/Desktop` | where `read_file` / `find_files` may look |
| `DEMERZEL_AGENT_HARNESS` | `claude` | passed to apiary — `codex`, `opencode` |
| `DEMERZEL_MEMORY` / `DEMERZEL_VOICES` / `DEMERZEL_TIMERS` / `DEMERZEL_MCP_CONFIG` | `~/.demerzel/*` | state |
| `DEMERZEL_RECORD` | off | dump utterances to `recordings/` for voiceprint calibration |

---

## Not done yet

Honest list, all of it in `docs/QUEUE.md`:

- **Smart Turn v3 is built but not wired.** It would replace the fixed 576 ms
  hangover — the single largest remaining chunk of latency — and it is
  unvalidated.
- **Pre-rendered TTS openers.** Cost tracks audio duration, so caching the audio
  for a small fixed set ("One moment", "Right", "Noted") takes the opener from
  ~395 ms to near zero while the real reply streams behind it.
- **The accent improvement is unverified on a real accent.** The published
  numbers are benchmarks; the synthetic Kokoro fixtures used here share a
  vocoder and cannot test a real speaker. Needs an A/B with an actual voice.
- **Voiceprint thresholds are calibrated on synthetic voices**, for the same
  reason, and may over- or under-state how hard real impostors are.
- **Barge-in is proven against a tone, not against real TTS.** 14 dB speech SNR
  over residual echo with AGC off — enough for wake-word detection during
  playback, not proven for full STT.
- **No search, no news, no calendar, no mail.** A deliberate hold, not an
  oversight.

---

## Credits

- **David** — **Groundswork** and **mcp-coord**, the prior art this borrows
  from. Demerzel's MCP client skill was built and verified against a live
  `agent-coord` server:
  connected, discovered 34 tools, registered them prefixed and marked local, and
  timed out a hanging call rather than wedging the turn.
- The **r/SelfHostedAI "C.O.R.T.A.N.A."** post that started this. We kept the
  premise (fully local, cascaded, with a face) and rejected the humanoid avatar
  and the wake-word model.
- **MLX**, **Kokoro**, **Silero VAD**, **3D-Speaker CAM++**, **mlx-audio**,
  **parakeet-mlx** — all of it runs on their work.

Lives in the `gorlitzer-labs/seldon` monorepo at
[`modules/demerzel`](https://github.com/gorlitzer-labs/seldon/tree/main/modules/demerzel)
(the old standalone `gorlitzer/demerzel` repo is gone). All paths below are
relative to this module directory.
