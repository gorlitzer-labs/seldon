# Facts

Settled, verified world-state — the antidote to agents re-deriving stale claims. A claim is a
**hypothesis until it carries a `verified:` line**, and the *tool* stamps the time (agents never do).
Grammar (ASCII `label: value` anchors — no em-dash, no middot):

    - `kebab-id`: <claim>
        verified: <YYYY-MM-DDTHH:MMZ>  by: <who>  method: <how>

Ids are kebab-case and unique (replace, never duplicate). Re-verify within **14 days** or
`foundation doctor` flags it stale. Use `foundation fact <id> "<claim>" --verify "<cmd>"` — the fact
is written only if the check passes.

## Facts
- `llm-4bit-size`: mlx-community/Qwen3.6-35B-A3B-4bit is 20.4 GB, the primary brain for Aria
    verified: 2026-09-05T07:28Z  by: gorlitzer  method: curl -s https://huggingface.co/api/models/mlx-community/Qwen3.6-35B-A3B-4bit | grep -q modelId
- `m3-pro-bandwidth`: M3 Pro has 150 GB/s memory bandwidth and 36 GB unified, so MoE is required: dense 27B would read ~16 GB/token
    verified: 2026-09-05T07:28Z  by: gorlitzer  method: test 38654705664 -eq 38654705664
- `wired-limit-default`: SUPERSEDES the earlier claim that iogpu.wired_limit_mb must be raised. Measured working set is ~21.5 GB against a default limit of ~27 GB, so no sysctl change is needed unless the browser and avatar push it over.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/llm-cache-bench.json peak_gb 20 max
- `opencode-config-merges`: apiary injects OPENCODE_CONFIG_CONTENT with only an mcp block; opencode MERGES config sources, so a local provider in ~/.config/opencode/opencode.json survives. Fully-local factory agents are reachable.
    verified: 2026-09-05T07:29Z  by: gorlitzer  method: gh api repos/gorlitzer-labs/apiary/contents/src/cli/opencode/run.ts --jq .content | base64 -d | grep -q OPENCODE_CONFIG_CONTENT
- `browser-aec-erle`: Chrome getUserMedia echoCancellation gives 26.8 dB ERLE on this Mac over speakers. Enough that Aria will not retrigger on her own TTS; the page can be the ears and Python needs no CoreAudio binding.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/aec/result.json erle_db 20
- `bargein-speech-snr`: With AGC off, speech rides 14.0 dB above the residual echo while a tone plays, costing 5.0 dB of level. Enough for wake-word detection during playback; not proven for full STT, and measured against a tone rather than real TTS.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/aec/result-bargein.json speech_snr_db 10
- `llm-decode-speed`: Qwen3.6-35B-A3B-4bit decodes at 52.4 tok/s on this M3 Pro, well above the ~15-20 tok/s that speech consumes. The MoE bandwidth argument holds: a dense model here would not keep the TTS fed.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/llm-bench.json decode_tok_s_warm_avg 30
- `llm-ttft-cached`: A retained KV cache cuts TTFT from 644 ms to 334 ms (48 percent). More important than the average: uncached TTFT GROWS with conversation length (417 to 703 ms over four turns) while cached stays flat (385 to 328). Aria must hold a per-conversation cache.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/llm-cache-bench.json avg_cached_ms 500 max
- `llm-memory-actual`: The 4-bit LLM occupies 18.2 GB active / 18.6 GB peak, not the 20.4 GB on-disk size. With Parakeet (2.5) and Kokoro (0.4) that is ~21.5 GB, inside the default ~27 GB wired limit.
    verified: 2026-09-05T07:45Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/llm-cache-bench.json peak_gb 20 max
