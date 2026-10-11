"""Load and warm Demerzel's three models, in the order that keeps them fast.

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

import atexit
import os
import pathlib
import tempfile
import time

import mlx.core as mx

from .models import Brain, Ears, Voice

GB = 1 << 30
CACHE_GB = 4
LOCK = pathlib.Path(tempfile.gettempdir()) / "demerzel-models.lock"


def _physical_gb() -> float:
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / GB


def wired_gb() -> float:
    """Cap wired memory at 60% of RAM.

    Wired memory cannot be paged out. An earlier hardcoded 24 GB was 67% of this
    36 GB machine, which is survivable for ONE process and fatal for two: running
    a benchmark while the server was loaded asked for 48 GB of non-pageable
    memory on a 36 GB box with no swap, and hung the machine hard enough to need
    a power cycle. The lock below is the real fix; this is the second seatbelt.
    """
    return round(_physical_gb() * 0.60, 1)


def configure_memory() -> str:
    w = wired_gb()
    try:
        mx.set_wired_limit(int(w * GB))
        mx.set_cache_limit(int(CACHE_GB * GB))
        return f"wired {w} GB of {_physical_gb():.0f} GB, cache {CACHE_GB} GB"
    except Exception as e:                       # non-fatal: just slower
        return f"could not set memory limits ({type(e).__name__}: {e})"


def _holder() -> int | None:
    """PID currently holding the model lock, if it is still alive."""
    try:
        pid = int(LOCK.read_text().strip())
    except Exception:
        return None
    try:
        os.kill(pid, 0)          # signal 0 = liveness probe, does not kill
        return pid
    except OSError:
        return None              # stale lock from a process that died


def acquire_models_lock() -> None:
    """Refuse to load a second copy of the models on this machine.

    Demerzel's working set is ~20.5 GB of a 36 GB machine. Two processes holding
    it do not merely thrash -- with MLX wired limits set they exhausted
    non-pageable memory and hung the Mac, which is exactly how the first crash
    happened (a benchmark launched while the server was running).

    Set DEMERZEL_ALLOW_MULTI=1 only if you genuinely have the headroom.
    """
    if os.environ.get("DEMERZEL_ALLOW_MULTI", "").lower() in {"1", "true", "yes"}:
        return
    pid = _holder()
    if pid is not None:
        raise RuntimeError(
            f"another Demerzel process (pid {pid}) already has the models loaded.\n"
            f"  Loading a second copy needs ~{2 * 20.5:.0f} GB on a "
            f"{_physical_gb():.0f} GB machine and will hang it.\n"
            f"  Stop it first:  kill {pid}\n"
            f"  Override (only with real headroom):  DEMERZEL_ALLOW_MULTI=1")
    LOCK.write_text(str(os.getpid()))
    atexit.register(release_models_lock)


def release_models_lock() -> None:
    try:
        if LOCK.exists() and LOCK.read_text().strip() == str(os.getpid()):
            LOCK.unlink()
    except Exception:
        pass


def load_all(verbose: bool = True) -> tuple[Ears, Brain, Voice]:
    say = print if verbose else (lambda *a, **k: None)
    acquire_models_lock()          # before any weights are touched
    say(f"memory: {configure_memory()}", flush=True)
    t0 = time.perf_counter()
    from .models import STT_BACKEND
    say(f"loading ears ({STT_BACKEND}) ...", flush=True)
    ears = Ears()
    say("loading voice (kokoro) ...", flush=True)
    voice = Voice()
    # Brain backend: default is the in-process MLX model (Qwen). Set
    # DEMERZEL_BRAIN=bonsai (or DEMERZEL_LLM_SERVER=<url>) to use a local
    # OpenAI-compatible server instead -- no 20 GB in-process LLM.
    if os.environ.get("DEMERZEL_BRAIN", "").lower() == "bonsai" or os.environ.get("DEMERZEL_LLM_SERVER"):
        from .brain_bonsai import BonsaiBrain, server_url, server_healthy
        if not server_healthy():
            raise RuntimeError(
                f"DEMERZEL_BRAIN=bonsai but no server at {server_url()} "
                f"(start it with `seldon up` / the Bonsai llama-server).")
        say(f"brain: bonsai server @ {server_url()} (no in-process LLM)", flush=True)
        brain = BonsaiBrain()
    else:
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
