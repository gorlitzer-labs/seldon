#!/usr/bin/env python3
"""Run full turns with no browser and no microphone.

Feeds recorded speech through the same Endpointer -> Ears -> Brain -> Voice path
the live server uses, so a wiring bug surfaces here rather than while someone is
talking to it.

Runs the clip TWICE. The first turn still carries some one-off cost; the second
is what a real conversation feels like. Reporting only the first would overstate
the latency, reporting only the second would flatter it.
"""
import json, sys, time, warnings
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, librosa

sys.path.insert(0, ".")
from demerzel.audio import Endpointer
from demerzel.protocol import MIC_SR
from demerzel.runtime import load_all
from demerzel.turn import run_turn

CLIP = sys.argv[1] if len(sys.argv) > 1 else "spikes/utt-medium.wav"
TURNS = 2

ears, brain, voice = load_all()

wav, sr = sf.read(CLIP, dtype="float32")
if wav.ndim > 1:
    wav = wav.mean(axis=1)
if sr != MIC_SR:
    wav = librosa.resample(wav, orig_sr=sr, target_sr=MIC_SR)
print(f"\nclip: {len(wav)/MIC_SR:.1f}s of speech, then silence", flush=True)
# Real capture never ends exactly at the last word; pad so the endpointer fires.
wav = np.concatenate([wav, np.zeros(MIC_SR, dtype=np.float32)])

results = []
for turn in range(1, TURNS + 1):
    print(f"\n--- turn {turn} ---", flush=True)
    ep = Endpointer()
    audio_out = []
    fired = False
    for i in range(0, len(wav), 1024):
        if fired:
            break
        for kind, frame in ep.push(wav[i:i + 1024]):
            if kind == "start":
                ears.open(); ears.feed(frame)
            elif kind == "audio":
                ears.feed(frame)
            elif kind == "abort":
                ears.close()
            elif kind == "end":
                ended = time.perf_counter()
                transcript = ears.close()
                print(f"  heard: {transcript!r}", flush=True)
                m = run_turn(ears, brain, voice, transcript=transcript,
                             speech_ended_at=ended,
                             emit=lambda x: None,
                             emit_audio=lambda a: audio_out.append(np.asarray(a, dtype=np.float32)),
                             should_stop=lambda: False)
                results.append(m)
                print(f"  STT {m.stt_ms:6.0f} ms | LLM first token {m.ttft_ms:6.0f} ms "
                      f"| first audio {m.tts_first_ms:6.0f} ms", flush=True)
                fired = True
                break

if not results:
    print("NO TURN FIRED - the endpointer never detected a complete utterance.")
    sys.exit(1)

last = results[-1]
print("\n" + "=" * 58)
print(f"  STT after speech end        {last.stt_ms:7.0f} ms")
print(f"  LLM first token             {last.ttft_ms:7.0f} ms")
print(f"  first audio out             {last.tts_first_ms:7.0f} ms")
print("-" * 58)
print(f"  ENDPOINT -> FIRST WORD      {last.tts_first_ms:7.0f} ms")
print(f"  + VAD hangover              {Endpointer().hangover_ms:7.0f} ms")
print(f"  = FROM YOUR LAST WORD       {last.tts_first_ms + Endpointer().hangover_ms:7.0f} ms")
print("=" * 58, flush=True)
if audio_out:
    sf.write("spikes/smoke-reply.wav", np.concatenate(audio_out), 24000)
json.dump({"turns": [{"stt_ms": r.stt_ms, "ttft_ms": r.ttft_ms,
                      "first_audio_ms": r.tts_first_ms} for r in results],
           "steady_endpoint_to_word_ms": last.tts_first_ms,
           "hangover_ms": Endpointer().hangover_ms,
           "steady_from_last_word_ms": last.tts_first_ms + Endpointer().hangover_ms},
          open("spikes/smoke.json", "w"), indent=2)
print("wrote spikes/smoke.json", flush=True)
