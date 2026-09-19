#!/usr/bin/env python3
"""Why is Kokoro's first audio slow, and can chunking fix it?

KPipeline yields per SENTENCE, so "time to first audio" is really "time to
synthesize the whole first sentence" -- it is not a streaming first frame.
That means first-audio latency is a function of how long the opening chunk is,
which is something we control.

Demerzel streams the LLM token-by-token anyway, so she can synthesize a short
opening clause immediately and keep synthesizing while it plays.
"""
import json, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
from kokoro import KPipeline

pipe = KPipeline(lang_code="a")
SR = 24000

# Same information, progressively shorter opening chunk.
CASES = [
    ("one long sentence", ["Demerzel on netreach is blocked on a storage decision, Postgres or SQLite?"]),
    ("split at the comma", ["Demerzel on netreach is blocked on a storage decision.", "Postgres or SQLite?"]),
    ("short opener first", ["Heads up.", "Demerzel on netreach is blocked on a storage decision.", "Postgres or SQLite?"]),
]

# warm up so we are not measuring graph build
for _ in pipe("warm up", voice="af_heart"):
    pass

rows = []
for label, parts in CASES:
    t0 = time.perf_counter()
    first = None
    total_audio = 0.0
    for part in parts:
        for _, _, audio in pipe(part, voice="af_heart", speed=1):
            if first is None:
                first = time.perf_counter() - t0
            total_audio += len(np.asarray(audio)) / SR
    total = time.perf_counter() - t0
    rows.append({"case": label, "first_audio_ms": first * 1000,
                 "total_s": total, "audio_s": total_audio})
    print(f"  {label:22s} first audio {first*1000:6.0f} ms   "
          f"({total_audio:.1f}s speech synthesized in {total:.2f}s)", flush=True)

best = min(r["first_audio_ms"] for r in rows)
worst = max(r["first_audio_ms"] for r in rows)
print("\n" + "=" * 58, flush=True)
print(f"  first audio, one long sentence   {worst:7.0f} ms", flush=True)
print(f"  first audio, short opener        {best:7.0f} ms", flush=True)
print(f"  latency recovered by chunking    {worst-best:7.0f} ms", flush=True)
print("=" * 58, flush=True)
json.dump({"cases": rows, "best_first_audio_ms": best, "worst_first_audio_ms": worst},
          open("spikes/tts-chunk-bench.json", "w"), indent=2)
print("wrote spikes/tts-chunk-bench.json", flush=True)
