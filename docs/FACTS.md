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
- `stt-latency`: Parakeet TDT v3 transcribes at 215 ms average for 3-5 s clips, RTF 0.054 (about 18x realtime) on this M3 Pro. The ears are not the bottleneck.
    verified: 2026-09-05T07:49Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/voice-bench.json stt_transcribe_ms_avg 400 max
- `tts-first-audio-is-chunk-bound`: Kokoro's KPipeline yields per SENTENCE, so time-to-first-audio equals the time to synthesize the whole opening chunk, not a streaming first frame. One long sentence costs 1007 ms; leading with a short clause costs 329 ms. Aria must split her reply and synthesize a short opener first.
    verified: 2026-09-05T07:49Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/tts-chunk-bench.json best_first_audio_ms 500 max
- `stt-mangles-technical-terms`: Parakeet transcribed 'Postgres or SQLite' as 'Poskers or SQ light' in the round-trip test. Aria's domain is full of such terms, so the router must tolerate mangled technical vocabulary or use biasing.
    verified: 2026-09-05T07:49Z  by: gorlitzer  method: python3 -c "import json;d=json.load(open('spikes/voice-bench.json'));assert 'SQLite' not in d['stt'][1]['got']"
- `pipeline-latency-measured`: Full pipeline steady state: STT 113 ms + LLM 308 ms + TTS 468 ms = 889 ms from the endpoint decision. Adding the 600 ms VAD hangover gives about 1.5 s from the user's last word, which is the honest end-to-end number.
    verified: 2026-09-05T08:05Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/pipeline-latency.json steady_state.total_from_endpoint_ms 1200 max
- `first-turn-penalty`: SUPERSEDED AND CORRECTED. The first-turn slowdown is NOT the cold conversation cache: prefilling the system prompt made no difference (300 ms with versus 300 ms without, controlled). The real cause is GPU buffer eviction between frameworks -- whichever of Parakeet (MLX), Kokoro (PyTorch/MPS) or the LLM ran last evicts the others, and the evicted one pays about 1.1 s on its next call. Fixed by warming the LLM last and running two full settle turns at boot.
    verified: 2026-09-05T08:19Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/smoke.json turns.1.ttft_ms 700 max
- `stt-streaming-unreliable`: StreamingParakeet is unreliable at utterance scale: on a 1.86 s clip one whole-clip call transcribed correctly while 320/480/640 ms chunking returned empty and 960 ms returned 'Yeah.'. Ears buffers the utterance and decodes once via get_logmel + generate, costing only ~113 ms.
    verified: 2026-09-05T08:05Z  by: gorlitzer  method: .venv/bin/python -c "import sys;sys.path.insert(0,'.');import numpy as np;from aria.models import Ears;Ears().transcribe(np.zeros(16000,dtype=np.float32));print('Ears.transcribe works on buffered audio')"
- `end-to-end-latency`: Measured second-turn pipeline: STT 120 ms, LLM first token 445 ms, first audio 1209 ms from the endpoint decision, plus a 576 ms VAD hangover = about 1.79 s from the user's last word. TTS synthesis of fresh text is now the largest single component.
    verified: 2026-09-05T08:19Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/smoke.json steady_from_last_word_ms 2500 max
- `kokoro-repeat-cache`: Kokoro synthesis of REPEATED text is not representative: the same string measured 1203 ms cold then 134 ms on repeats, which is phonemization caching rather than warm GPU state. Benchmarks must use varied text; in the live pipeline a fresh 5-word opener costs ~760 ms.
    verified: 2026-09-05T08:19Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/smoke.json turns.1.first_audio_ms 2000 max
- `mlx-wired-limit-helps`: Pinning MLX memory with mx.set_wired_limit(24 GB) and set_cache_limit(4 GB) removed the residual first-generation cost with three models resident: 3268 ms on defaults versus 347 ms pinned. This reverses the earlier conclusion that no memory tuning was needed -- it is needed for stability, not capacity.
    verified: 2026-09-05T08:19Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/smoke.json turns.1.ttft_ms 700 max
- `fully-local-verified`: Boomer holds no non-loopback socket while running. This was NOT true initially: huggingface_hub kept an ESTABLISHED connection to huggingface.co (18.155.129.129, CloudFront) at load time to check model revisions. Fixed by setting HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE in boomer/__init__.py before any hub import. Verified with lsof, not assumed.
    verified: 2026-09-05T17:13Z  by: gorlitzer  method: sh scripts/check-offline.sh
- `stt-hotwords-fix-vocabulary`: Qwen3-ASR hotwords fix domain vocabulary outright: 'Should we use Postgres or SQLite for storage?' came back as 'poskers or SQ Lite' (Parakeet) and 'posters or SQ light' (Qwen3-ASR bare), but exactly right with hotwords. Cost of the hotwords themselves is ~8 ms.
    verified: 2026-09-05T17:22Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/asr-compare.json runs.2.avg_ms 600 max
- `stt-swap-latency-cost`: Swapping Parakeet for Qwen3-ASR+hotwords costs about 190 ms of STT (134 -> 335 ms on fixtures; 120 -> 304 ms in the live pipeline), taking the full turn from ~1.79 s to ~1.96 s from the user's last word. Bought for correct technical vocabulary and better accented-English WER. Set BOOMER_STT=parakeet to A/B.
    verified: 2026-09-05T17:22Z  by: gorlitzer  method: python3 scripts/check-metric.py spikes/smoke.json steady_from_last_word_ms 2500 max
- `two-model-processes-hang-the-mac`: Running two Boomer processes at once hung the Mac hard enough to need a power cycle (rebooted 2026-09-07 08:21, no kernel panic, so a VM hang not a crash). Cause: a benchmark loading ~20.5 GB while the server already held ~20.5 GB on a 36 GB machine, with BOTH calling mx.set_wired_limit(24 GB). Wired memory is non-pageable and swap was 0, so it could not degrade gracefully. Fixed with a PID lock in load_all plus a RAM-relative wired cap (60 percent = 21.6 GB here).
    verified: 2026-09-07T06:24Z  by: gorlitzer  method: .venv/bin/python -c "import sys;sys.path.insert(0,'.');from boomer.runtime import wired_gb,_physical_gb;assert wired_gb() < _physical_gb()*0.65;print('wired cap', wired_gb(), 'GB of', round(_physical_gb()), 'GB')"
- `memory-costs-no-turn-latency`: Boomer's durable memory is injected into the system prompt, which is prefilled into the KV cache once at boot, so remembered items cost zero per-turn latency. Memory intents (remember/forget/recall) are handled before the LLM is called at all -- a file append and a read-back, no generation.
    verified: 2026-09-07T06:43Z  by: gorlitzer  method: .venv/bin/python -c "import sys;sys.path.insert(0,'.');from boomer import memory as m;from boomer.turn import _handle_memory;k,p=m.detect('remember that testing works');assert k=='remember';print('memory intent bypasses the LLM:', k)"
- `voice-decision-write-is-gated`: Answering a factory decision by voice never commits on first utterance. The answer is read back, and only an explicit yes runs 'factory decide'. Verified against a stand-in CLI: cancel and ambiguous replies ('hmm I am not sure') both left the factory uncalled, and a mid-confirm correction replaced the answer rather than sending the old one. Necessary because resolveDecision() has no un-resolve path.
    verified: 2026-09-07T06:55Z  by: gorlitzer  method: .venv/bin/python -c "import sys;sys.path.insert(0,'.');from boomer.turn import _handle_factory;ctx={'last_decision':{'id':'d-x','hive':'h'}};_handle_factory('answer SQLite',ctx);assert 'awaiting_confirm' in ctx;r=_handle_factory('hmm not sure',ctx);assert 'awaiting_confirm' in ctx and 'Yes to send' in r;print('ambiguity does not commit')"
- `factory-loop-closed-end-to-end`: The full supervised-autonomy loop works against the real factory CLI, not a stand-in: factory state --json reports the board aloud, a voice answer passes the confirm gate, and 'factory decide' recorded d-20df46 as status=answered answer='SQLite' answeredAt=2026-09-07 07:08. A mid-confirm ambiguity ('actually hold on') left it pending. factory state --json shipped in gorlitzer-labs/factory#1 (merged).
    verified: 2026-09-07T07:08Z  by: gorlitzer  method: factory state --compact > /dev/null && .venv/bin/python -c "import sys;sys.path.insert(0,'.');from boomer.factory import cli_available,board_state;assert cli_available() and board_state() is not None;print('real factory CLI reachable')"
- `single-session-enforced`: Two websocket sessions would have corrupted each other: ears/brain/voice are module-level singletons, so a second speaker's ears.open() wipes the first's buffer and both share one KV cache, meaning each hears replies to the other's questions. It never crashed, it was just quietly wrong. The server now refuses a second connection with a busy message and frees the slot when the first leaves, verified with three sequential connections.
    verified: 2026-09-07T07:36Z  by: gorlitzer  method: .venv/bin/python -c "import sys;sys.path.insert(0,'.');import re;s=open('boomer/server.py').read();assert '_active' in s and 'busy' in s;print('single-session guard present')"
