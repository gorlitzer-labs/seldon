"""Capture real utterances, so claims about accents and turn-taking can be tested.

Two open questions cannot be settled with synthesized audio:

  * whether Qwen3-ASR actually hears Franko's accent better than Parakeet
  * whether Smart Turn v3 can tell a finished sentence from a pause

Both need real speech. Rather than staging more live sessions, the server can
record what it already captures: the utterance audio plus what it thought was
said. Replaying that corpus offline answers both, repeatably.

Off by default -- this is a microphone writing to disk. Enable with
BOOMER_RECORD=1; files land in recordings/ (git-ignored).
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib

import numpy as np

from .protocol import MIC_SR

ENABLED = os.environ.get("BOOMER_RECORD", "").lower() in {"1", "true", "yes"}
DIR = pathlib.Path(__file__).resolve().parent.parent / "recordings"


def record_utterance(audio: np.ndarray | None, transcript: str) -> str | None:
    """Write one utterance + its transcript. Returns the stem, or None if disabled."""
    if not ENABLED or audio is None or not len(audio):
        return None
    try:
        import soundfile as sf
        DIR.mkdir(exist_ok=True)
        stem = _dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        sf.write(DIR / f"{stem}.wav", np.asarray(audio, dtype=np.float32), MIC_SR)
        (DIR / f"{stem}.json").write_text(json.dumps(
            {"transcript": transcript, "seconds": len(audio) / MIC_SR,
             "stt": os.environ.get("BOOMER_STT", "qwen")}, indent=2))
        return stem
    except Exception:
        return None            # recording must never break a turn
