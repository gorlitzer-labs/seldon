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
