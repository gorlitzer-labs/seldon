#!/usr/bin/env python3
"""Does a retained KV cache cut Aria's time-to-first-token?

The uncached bench re-prefills the system prompt on every turn. A real
conversation keeps the cache and only prefills the new user turn. This measures
that difference, plus the cold-start penalty that decides whether she needs a
warmup inference at boot.
"""
import json, time
import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.sample_utils import make_sampler

MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit"
SYSTEM = ("You are Aria, a local voice assistant. Answer in one or two short "
          "spoken sentences. Never use markdown or lists.")
TURNS = ["What's on the board?",
         "And how many are blocked?",
         "Thanks. What about netreach?",
         "Got it. Anything else needing me?"]

model, tokenizer = load(MODEL)
sampler = make_sampler(temp=0.7, top_p=0.9)


def run(label, shared_cache):
    cache = make_prompt_cache(model) if shared_cache else None
    msgs = [{"role": "system", "content": SYSTEM}]
    out = []
    for t in TURNS:
        msgs.append({"role": "user", "content": t})
        if shared_cache:
            # Only the new turn needs prefilling; the cache holds the rest.
            prompt = tokenizer.apply_chat_template(
                msgs[-1:], add_generation_prompt=True, tokenize=False)
            if len(msgs) == 2:
                prompt = tokenizer.apply_chat_template(
                    msgs, add_generation_prompt=True, tokenize=False)
        else:
            prompt = tokenizer.apply_chat_template(
                msgs, add_generation_prompt=True, tokenize=False)
        t0 = time.perf_counter()
        ttft, n, chunks = None, 0, []
        kw = {"prompt_cache": cache} if cache is not None else {}
        for r in stream_generate(model, tokenizer, prompt, max_tokens=48,
                                 sampler=sampler, **kw):
            if ttft is None:
                ttft = time.perf_counter() - t0
            n += 1
            chunks.append(r.text)
        reply = "".join(chunks).strip()
        msgs.append({"role": "assistant", "content": reply})
        out.append(ttft * 1000)
        print(f"  [{label}] turn {len(out)}  TTFT {ttft*1000:6.0f} ms  ({n} tok)", flush=True)
    return out


print("warming up (first inference builds the graph) ...", flush=True)
t0 = time.perf_counter()
for _ in stream_generate(model, tokenizer, "hi", max_tokens=1):
    pass
print(f"  cold-start warmup took {time.perf_counter()-t0:.1f}s\n", flush=True)

print("A. no cache -- system prompt re-prefilled every turn", flush=True)
nocache = run("nocache", False)
print("\nB. retained cache -- only the new turn is prefilled", flush=True)
cached = run("cached", True)

a = sum(nocache[1:]) / len(nocache[1:])
b = sum(cached[1:]) / len(cached[1:])
print("\n" + "=" * 58, flush=True)
print(f"  TTFT no cache (avg)    {a:7.0f} ms", flush=True)
print(f"  TTFT with cache (avg)  {b:7.0f} ms", flush=True)
print(f"  saved                  {a-b:7.0f} ms  ({100*(a-b)/a:.0f}%)", flush=True)
print(f"  peak memory            {mx.get_peak_memory()/(1<<30):7.1f} GB", flush=True)
print("=" * 58, flush=True)
json.dump({"ttft_nocache_ms": nocache, "ttft_cached_ms": cached,
           "avg_nocache_ms": a, "avg_cached_ms": b,
           "peak_gb": mx.get_peak_memory() / (1 << 30)},
          open("spikes/llm-cache-bench.json", "w"), indent=2)
print("wrote spikes/llm-cache-bench.json", flush=True)
