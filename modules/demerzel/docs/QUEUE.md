# Queue
<!-- foundation:schema queue.v1 -->

Inbound work, not yet claimed. **Single writer:** `/plan-phase` (or a human/liaison). Executors
never edit this file. Grammar (ASCII, no fancy glyphs):

    - [ ] (P1) <text>          priority is P1 | P2 | P3

Use `foundation queue "(P1) <text>"` to append — never hand-edit.

## Queue
- [ ] (P1) Spike acoustic echo cancellation on macOS: mic + speaker on one machine, barge-in must work. Biggest unknown, blocks the voice loop.
- [ ] (P1) factory state --json: expose hiveState/readRegistry/pending as JSON so terminal, voice and avatar share one state function.
- [ ] (P1) Python client reads factory state --json and prints the board. Proves the seam with zero ML.
- [ ] (P1) Audio I/O ring buffer + VAD gate (sounddevice), 16kHz mono capture.
- [ ] (P1) Wake word: train 'hey aria' openWakeWord model with hard negatives (area, aria, Maria, Arya).
- [ ] (P1) STT: parakeet-mlx streaming transcription, measure time from speech end to final transcript.
- [ ] (P1) Turn detection: Smart Turn v3 int8 ONNX on the VAD silence. Measure endpointing delay.
- [ ] (P1) LLM: mlx_lm.server with Qwen3.6-35B-A3B-4bit, OpenAI-compatible on localhost. Measure TTFT.
- [ ] (P1) TTS: Kokoro-82M via PyTorch KPipeline, sentence-by-sentence streaming. Do NOT use the MLX port.
- [ ] (P1) Event bus + websocket :8765. Define the state protocol before any avatar work.
- [ ] (P2) Voice tool: speak the board and pending decisions aloud.
- [ ] (P2) Voice tool: answer a decision by voice, with mandatory read-back confirm before the write.
- [ ] (P2) Proactive announce: new DECISION/BLOCKER spoken as they land. The 24/7 payoff.
- [ ] (P2) Model contention policy: yield the LLM to the voice path on wake, agents run at low priority.
- [ ] (P3) three.js hologram avatar as a pure consumer of the :8765 state protocol.
- [ ] (P3) Performance mode dashboard driven by the same factory state --json.
- [ ] (P1) AEC follow-up: AGC confounds the measurement (aec-on residual sits 14.5 dB BELOW the noise floor). Test speech intelligibility while the tone plays, with autoGainControl off, before trusting barge-in.
- [ ] (P1) Re-run the barge-in spike using real Kokoro TTS as the playback source, not a 440/880 Hz tone. Broadband speech occupies the same spectrum as the user's voice and is the genuinely hard case for AEC.
- [ ] (P2) Barge-in design: gate interruption on the wake word during playback, not full STT. A wake-word model tolerates far less SNR than transcription does.
- [ ] (P1) Warm the model at boot with a throwaway inference: the first generation after load costs 3.7-8 s of graph build, which would land on the user's first ever utterance.
- [ ] (P1) TTS chunking: split the LLM reply at the first clause boundary and synthesize that opener immediately, then continue. Worth 678 ms of perceived latency.
- [ ] (P2) STT vocabulary: Parakeet mangles technical terms (Postgres, SQLite). Investigate biasing or an LLM-side correction pass before the router acts on a transcript.
- [ ] (P1) Pre-warm the conversation KV cache at boot with the system prompt, so the first real turn does not pay the 1365 ms cold-cache penalty.
- [ ] (P1) Replace the fixed 600 ms VAD hangover with Smart Turn v3. It is now the single largest contributor to perceived latency: 600 of the ~1489 ms a user actually experiences.
- [ ] (P2) SUPERSEDES the earlier 'hey aria' wake word item: train the wake word on 'demerzel' instead. The plosive /b/ is acoustically stronger than 'aria', which Parakeet was observed hearing as 'area'. Hard negatives: demerzel, bloomer, boom, room.
- [ ] (P1) TTS is now the biggest cost at ~760 ms for a fresh 5-word opener, against 329 ms measured in isolation. Investigate misaki/spacy phonemization cost per utterance and whether the opener can be pre-synthesized from a small fixed set.
- [ ] (P1) Swap Parakeet for Qwen3-ASR-1.7B on accented English. Qwen3-ASR scores 16.07 WER on dialog-accented English vs Whisper large-v3's 21.30, and narrows the L1-English to L1-other gap to 1.1x against Whisper's 2.2x. mlx-community/Qwen3-ASR-1.7B-8bit is 2.47 GB, near-identical to Parakeet's 2.5 GB.
- [ ] (P2) Have the LLM repair mangled transcripts before the router acts. Published work on accented-ASR errors recommends LLM-based remedies, and a 35B model is already in the loop.
- [ ] (P2) Qwen3-ASR appears to worsen LLM TTFT (445 -> 611 ms), likely more GPU eviction than Parakeet caused. Try more settle rounds or interleaving the models differently.
- [ ] (P1) Verify the accent improvement with David's own voice, A/B via DEMERZEL_STT. The published accent numbers are from benchmarks; the synthetic TTS fixtures used here cannot test a real accent.
- [ ] (P1) Never launch a benchmark or smoke test while the server is running. The lock now enforces it, but scripts should also fail fast with a clear message rather than being started at all.
- [ ] (P2) Memory retrieval is the whole store in the system prompt, which is right for dozens of items and wrong for thousands. Revisit only when the store outgrows the context -- do not add a vector index before then.
- [ ] (P2) Demerzel reads hive state via 'factory state --json' (gorlitzer-labs/factory#1) but reads decisions.json directly. That split is deliberate -- computed state through the CLI, plain data files direct -- and should be revisited if the decisions schema ever gains logic.
- [ ] (P2) Before any Tailscale share: confirm DEMERZEL_READONLY=1 is set for the shared session, and that the CTO's browser mic audio crossing the tailnet is understood and acceptable. Sharing voids the loopback-only guarantee that fully-local-verified rests on.
- [ ] (P1) SUPERSEDES the accent-verification item that named the wrong person: verify the accent improvement with FRANKO's own voice, A/B via DEMERZEL_STT. I had inferred the name David from unrelated skill descriptions; the repo's own package.json says Franco Berardi.
- [ ] (P3) Avatar next steps: thinking-state data lattice, gaze that tracks the listening state, and the performance-mode dashboard reading the same factory state --json.
- [ ] (P3) Avatar polish: the amber (user) spectrum muddies where it overlaps hers. Consider a subtractive or offset baseline so the two voices stay legible when both are active.
- [ ] (P1) Calibrate the voiceprint on Franko's real voice and real room: record with DEMERZEL_RECORD=1, enrol with scripts/enroll.py, and check the reported self-similarity. The current thresholds came from synthetic Kokoro voices, which share a vocoder and so may either overstate or understate how hard real impostors are.
- [ ] (P3) UI polish: her transcript line is capped at 34ch which wraps early on a wide window, and the roster's forget action sits hard against the right edge. Both cosmetic.
- [ ] (P2) Cut TTS first-audio by pre-synthesizing a small fixed set of openers (One moment / Right / Noted) and caching the AUDIO, since cost tracks spoken duration at RTF 0.23 and not text novelty. Would take the opener from ~395 ms to near zero while the real reply streams behind it.
- [ ] (P3) Log anchoring differs by breakpoint on purpose: mobile top-anchors so the conversation starts under the core, desktop bottom-anchors so the newest line sits by the rail. Revisit if it ever reads as inconsistent.
- [ ] (P2) try a shorter opening phrase
- [ ] (P2) MCP client as a skill: one integration turns every MCP server into a capability (apiary already exposes one, and playwright plus agent-coord are configured). Needed before search, calendar or mail can arrive without hardcoding each.
- [ ] (P1) Search and news are still absent by choice -- Franko chose to stay fully local for now. When revisited, decide the tier: self-hosted SearXNG (his infra) versus a provider API (hands queries out), and surface it per-capability in the UI the way the voice-check chip is.
