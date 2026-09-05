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
- `wired-limit-default`: iogpu.wired_limit_mb is 0 (default ~27 GB) and must be raised to ~30720 to hold the 24.8 GB working set
    verified: 2026-09-05T07:28Z  by: gorlitzer  method: sysctl -n iogpu.wired_limit_mb
- `opencode-config-merges`: apiary injects OPENCODE_CONFIG_CONTENT with only an mcp block; opencode MERGES config sources, so a local provider in ~/.config/opencode/opencode.json survives. Fully-local factory agents are reachable.
    verified: 2026-09-05T07:29Z  by: gorlitzer  method: gh api repos/gorlitzer-labs/apiary/contents/src/cli/opencode/run.ts --jq .content | base64 -d | grep -q OPENCODE_CONFIG_CONTENT
- `browser-aec-erle`: Chrome getUserMedia echoCancellation gives 26.8 dB ERLE on this Mac over speakers (tone -27.3 dBFS AEC off vs -54.0 dBFS AEC on). Enough that Aria will not retrigger on her own TTS. The page can be the ears; Python needs no CoreAudio binding.
    verified: 2026-09-05T07:35Z  by: gorlitzer  method: python3 spikes/aec/check.py
- `bargein-speech-snr`: With AGC off, speech rides 14.0 dB above the residual echo while a tone plays (speech p90 -40.5 dBFS vs residual -54.5), costing 5.0 dB of level. Enough SNR for wake-word detection during playback; NOT yet proven for full STT, and measured against a tone rather than real TTS.
    verified: 2026-09-05T07:40Z  by: gorlitzer  method: python3 spikes/aec/check.py result-bargein.json speech_snr_db 10
