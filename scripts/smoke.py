#!/usr/bin/env python3
"""Run one full turn with no browser and no microphone.

Feeds recorded speech through the same Endpointer -> Ears -> Brain -> Voice path
the live server uses, so a wiring bug surfaces here rather than while someone is
talking to it. Prints the real latency breakdown.
"""
import sys, time, warnings
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, librosa

sys.path.insert(0, ".")
from aria.audio import Endpointer
from aria.models import Brain, Ears, Voice
from aria.protocol import MIC_SR
from aria.turn import run_turn

CLIP = sys.argv[1] if len(sys.argv) > 1 else "spikes/tts-sample.wav"

print("loading models ...", flush=True)
t0 = time.perf_counter()
ears, brain, voice = Ears(), Brain(), Voice()
print(f"  loaded in {time.perf_counter()-t0:.1f}s", flush=True)
t0 = time.perf_counter()
ears.warm(); brain.warm(); voice.warm()
print(f"  warmed in {time.perf_counter()-t0:.1f}s", flush=True)

wav, sr = sf.read(CLIP, dtype="float32")
if wav.ndim > 1:
    wav = wav.mean(axis=1)
if sr != MIC_SR:
    wav = librosa.resample(wav, orig_sr=sr, target_sr=MIC_SR)
print(f"\nclip: {len(wav)/MIC_SR:.1f}s of speech, then silence\n", flush=True)

# Real capture never ends exactly at the last word; pad so the endpointer fires.
wav = np.concatenate([wav, np.zeros(MIC_SR, dtype=np.float32)])

ep = Endpointer()
audio_out = []
events = []
emit = lambda m: events.append(m) or print(f"  << {m}", flush=True)
emit_audio = lambda a: audio_out.append(np.asarray(a, dtype=np.float32))

speech_ended_at = None
CH = 1024
for i in range(0, len(wav), CH):
    for kind, frame in ep.push(wav[i:i + CH]):
        if kind == "start":
            ears.open(); ears.feed(frame)
            print("  >> speech start", flush=True)
        elif kind == "audio":
            ears.feed(frame)
        elif kind == "abort":
            ears.close(); print("  >> aborted (too short)", flush=True)
        elif kind == "end":
            speech_ended_at = time.perf_counter()
            print("  >> speech end -> turn", flush=True)
            transcript = ears.close()
            print(f"  >> heard: {transcript!r}", flush=True)
            m = run_turn(ears, brain, voice, transcript=transcript,
                         speech_ended_at=speech_ended_at, emit=emit,
                         emit_audio=emit_audio, should_stop=lambda: False)
            print("\n" + "=" * 58)
            print(f"  STT tail after speech end   {m.stt_ms:7.0f} ms")
            print(f"  LLM first token             {m.ttft_ms:7.0f} ms")
            print(f"  first audio out             {m.tts_first_ms:7.0f} ms")
            print("=" * 58)
            print(f"  MIC-TO-VOICE                {m.tts_first_ms:7.0f} ms")
            print("=" * 58, flush=True)
            if audio_out:
                out = np.concatenate(audio_out)
                sf.write("spikes/smoke-reply.wav", out, 24000)
                print(f"  reply audio: {len(out)/24000:.1f}s -> spikes/smoke-reply.wav")
            import json
            json.dump({"stt_ms": m.stt_ms, "ttft_ms": m.ttft_ms,
                       "mic_to_voice_ms": m.tts_first_ms,
                       "reply_chars": m.reply_chars},
                      open("spikes/smoke.json", "w"), indent=2)
            sys.exit(0)

print("NO TURN FIRED - the endpointer never detected a complete utterance.")
sys.exit(1)
