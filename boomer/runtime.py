"""Load and warm Boomer's three models, in the order that keeps them fast.

Two measured effects drive everything here:

1. Whichever model touches the GPU last evicts the others' buffers, and the
   next call by an evicted model pays about 1.1 s. Kokoro (PyTorch/MPS) and
   Parakeet (MLX) both do this to the LLM. So the LLM is warmed LAST -- it is
   the one on the critical path of every turn.

2. Pinning MLX's wired memory removes the residual first-call cost: with three
   models resident, the first generation measured 3268 ms on defaults and
   347 ms with the wired limit set.

Both the server and the smoke test load through here so they cannot drift apart.
"""
from __future__ import annotations

import time

import mlx.core as mx

from .models import Brain, Ears, Voice

GB = 1 << 30
WIRED_GB = 24      # working set is ~21.5 GB; headroom without starving macOS
CACHE_GB = 4


def configure_memory() -> str:
    try:
        mx.set_wired_limit(int(WIRED_GB * GB))
        mx.set_cache_limit(int(CACHE_GB * GB))
        return f"wired {WIRED_GB} GB, cache {CACHE_GB} GB"
    except Exception as e:                       # non-fatal: just slower
        return f"could not set memory limits ({type(e).__name__}: {e})"


def load_all(verbose: bool = True) -> tuple[Ears, Brain, Voice]:
    say = print if verbose else (lambda *a, **k: None)
    say(f"memory: {configure_memory()}", flush=True)
    t0 = time.perf_counter()
    say("loading ears (parakeet) ...", flush=True)
    ears = Ears()
    say("loading voice (kokoro) ...", flush=True)
    voice = Voice()
    say("loading brain (qwen3.6-35b-a3b) ...", flush=True)
    brain = Brain()
    say(f"loaded in {time.perf_counter()-t0:.1f}s -- warming ...", flush=True)

    t1 = time.perf_counter()
    ears.warm()
    voice.warm()
    brain.warm()          # LAST, so nothing evicts it afterwards

    # Individual warmups are not enough. Whichever model ran most recently has
    # evicted the others, and the evicted one pays ~1.1 s on its next call --
    # measured as 1203 ms for Kokoro right after the LLM warmed, then 134 ms
    # on every call after that. Running two complete turns settles the whole
    # rotation so the first real utterance sees steady state.
    settle(ears, brain, voice, rounds=2)
    say(f"warm in {time.perf_counter()-t1:.1f}s "
        f"(active {mx.get_active_memory()/GB:.1f} GB)", flush=True)
    return ears, brain, voice


def settle(ears: Ears, brain: Brain, voice: Voice, rounds: int = 2) -> None:
    """Run the full STT -> LLM -> TTS rotation so eviction costs are paid up front."""
    import numpy as np
    silence = np.zeros(16_000, dtype=np.float32)
    for _ in range(rounds):
        ears.transcribe(silence)
        for _ in brain.stream("hello", max_tokens=8):
            pass
        brain.reset()
        for _ in voice.say("Ready."):
            break
