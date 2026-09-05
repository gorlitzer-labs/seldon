#!/usr/bin/env python3
"""Measure Aria's ears and mouth, and close the loop between them.

Kokoro speaks a line, Parakeet transcribes the audio back. That yields both
benchmarks and proves the two ends agree -- a silent-audio or wrong-samplerate
bug shows up immediately as a garbage transcript rather than as a plausible
number.

The figures that matter for a voice turn:
  TTS time-to-first-audio -- when she starts speaking
  STT transcribe time     -- the wait after you stop speaking
"""
import json, time, warnings
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf

LINES = [
    "The board is clear. Nothing needs you right now.",
    "Aria on netreach is blocked on a storage decision. Postgres or SQLite?",
    "Four lanes are running and two tasks landed since this morning.",
]
OUT = "spikes/tts-sample.wav"
SR = 24000

# ---------- TTS ----------
from kokoro import KPipeline
print("loading Kokoro ...", flush=True)
t0 = time.perf_counter()
pipe = KPipeline(lang_code="a")
print(f"  loaded in {time.perf_counter()-t0:.1f}s", flush=True)

tts_rows, all_audio = [], []
for i, line in enumerate(LINES):
    t0 = time.perf_counter()
    first, chunks = None, []
    for _, _, audio in pipe(line, voice="af_heart", speed=1):
        if first is None:
            first = time.perf_counter() - t0
        chunks.append(np.asarray(audio, dtype=np.float32))
    total = time.perf_counter() - t0
    wav = np.concatenate(chunks)
    dur = len(wav) / SR
    rtf = total / dur
    tts_rows.append({"line": line, "first_audio_ms": first * 1000,
                     "total_s": total, "audio_s": dur, "rtf": rtf})
    all_audio.append(wav)
    print(f"  [tts {i+1}] first audio {first*1000:6.0f} ms | {dur:.1f}s speech in "
          f"{total:.2f}s | RTF {rtf:.3f} ({1/rtf:.0f}x realtime)", flush=True)

sf.write(OUT, np.concatenate(all_audio), SR)
print(f"  wrote {OUT}", flush=True)

# ---------- STT ----------
from parakeet_mlx import from_pretrained
print("\nloading Parakeet ...", flush=True)
t0 = time.perf_counter()
asr = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
print(f"  loaded in {time.perf_counter()-t0:.1f}s", flush=True)

# Warm up: first call builds the graph, same trap as the LLM.
t0 = time.perf_counter()
asr.transcribe(OUT)
warm = time.perf_counter() - t0
print(f"  cold first transcribe {warm:.1f}s (warmup)", flush=True)

stt_rows = []
for i, (line, wav) in enumerate(zip(LINES, all_audio)):
    p = f"spikes/tts-line-{i}.wav"
    sf.write(p, wav, SR)
    dur = len(wav) / SR
    t0 = time.perf_counter()
    res = asr.transcribe(p)
    el = time.perf_counter() - t0
    text = (res.text or "").strip()
    stt_rows.append({"expected": line, "got": text, "audio_s": dur,
                     "transcribe_s": el, "rtf": el / dur})
    print(f"\n  [stt {i+1}] {el*1000:6.0f} ms for {dur:.1f}s audio  (RTF {el/dur:.3f})", flush=True)
    print(f"      -> {text}", flush=True)

tts_first = sum(r["first_audio_ms"] for r in tts_rows) / len(tts_rows)
stt_ms = sum(r["transcribe_s"] for r in stt_rows) / len(stt_rows) * 1000
stt_rtf = sum(r["rtf"] for r in stt_rows) / len(stt_rows)

print("\n" + "=" * 58, flush=True)
print(f"  TTS first audio (avg)  {tts_first:7.0f} ms", flush=True)
print(f"  STT transcribe (avg)   {stt_ms:7.0f} ms", flush=True)
print(f"  STT realtime factor    {stt_rtf:7.3f}", flush=True)
print("=" * 58, flush=True)
json.dump({"tts": tts_rows, "stt": stt_rows, "tts_first_audio_ms_avg": tts_first,
           "stt_transcribe_ms_avg": stt_ms, "stt_rtf_avg": stt_rtf},
          open("spikes/voice-bench.json", "w"), indent=2)
print("wrote spikes/voice-bench.json", flush=True)
