#!/usr/bin/env python3
"""Measure what Boomer's brain actually does on this Mac.

Every latency figure in the plan so far is arithmetic from 150 GB/s. This
replaces it with measurement: load time, resident memory, time-to-first-token
and sustained decode, for short voice-shaped turns.

TTFT is the number that decides whether she feels alive. Sustained tok/s only
has to beat speech (~15-20 tok/s) to keep the TTS fed without gaps.
"""
import json, sys, time
import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler

MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit"
GB = 1 << 30

PROMPTS = [
    "What's on the board?",
    "Tell me in one sentence why the sky is blue.",
    "Boomer, is netreach still blocked?",
]

SYSTEM = ("You are Boomer, a local voice assistant. Answer in one or two short "
          "spoken sentences. Never use markdown or lists.")


def main():
    print(f"loading {MODEL} ...", flush=True)
    t0 = time.perf_counter()
    model, tokenizer = load(MODEL)
    load_s = time.perf_counter() - t0
    wired = mx.get_active_memory() / GB
    print(f"  loaded in {load_s:.1f}s   active memory {wired:.1f} GB", flush=True)

    # Thinking mode is death for voice latency -- turn it off if the template has it.
    def render(user):
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        try:
            return tokenizer.apply_chat_template(
                msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        except TypeError:
            return tokenizer.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)

    sampler = make_sampler(temp=0.7, top_p=0.9)
    rows = []
    for i, p in enumerate(PROMPTS):
        prompt = render(p)
        t0 = time.perf_counter()
        ttft = None
        n = 0
        text = []
        for resp in stream_generate(model, tokenizer, prompt, max_tokens=60, sampler=sampler):
            if ttft is None:
                ttft = time.perf_counter() - t0
            n += 1
            text.append(resp.text)
        total = time.perf_counter() - t0
        decode_tps = (n - 1) / (total - ttft) if n > 1 and total > ttft else 0.0
        rows.append({"prompt": p, "ttft_ms": ttft * 1000, "tokens": n,
                     "decode_tok_s": decode_tps, "total_s": total,
                     "reply": "".join(text).strip()[:120]})
        print(f"\n[{i+1}] {p}", flush=True)
        print(f"    TTFT {ttft*1000:7.0f} ms   decode {decode_tps:5.1f} tok/s   {n} tokens", flush=True)
        print(f"    -> {rows[-1]['reply']}", flush=True)

    peak = mx.get_peak_memory() / GB
    warm = [r for r in rows[1:]]            # first call includes lazy graph warmup
    avg_ttft = sum(r["ttft_ms"] for r in warm) / len(warm)
    avg_tps = sum(r["decode_tok_s"] for r in warm) / len(warm)

    print("\n" + "=" * 58, flush=True)
    print(f"  model load             {load_s:7.1f} s", flush=True)
    print(f"  active memory          {wired:7.1f} GB", flush=True)
    print(f"  peak memory            {peak:7.1f} GB", flush=True)
    print(f"  TTFT (warm, avg)       {avg_ttft:7.0f} ms", flush=True)
    print(f"  decode (warm, avg)     {avg_tps:7.1f} tok/s", flush=True)
    print("=" * 58, flush=True)
    verdict = ("snappy enough for voice" if avg_ttft < 400 and avg_tps > 20 else
               "usable but the turn will feel slow" if avg_ttft < 900 else
               "too slow for conversational voice")
    print(f"  VERDICT: {verdict}\n", flush=True)

    json.dump({"model": MODEL, "load_s": load_s, "active_gb": wired, "peak_gb": peak,
               "ttft_ms_warm_avg": avg_ttft, "decode_tok_s_warm_avg": avg_tps,
               "runs": rows}, open("spikes/llm-bench.json", "w"), indent=2)
    print("wrote spikes/llm-bench.json", flush=True)


if __name__ == "__main__":
    main()
