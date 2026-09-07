"""Does Boomer know it is Franko talking?

An always-listening assistant with a write path is a security problem, not just
a convenience one. Right now anyone within earshot could say "go with SQLite,
yes" and permanently resolve a real factory decision in his name -- the confirm
gate protects against MISHEARING, not against a different person.

So: a speaker voiceprint. CAM++ from the 3D-Speaker project, the English
VoxCeleb checkpoint, 29.6 MB ONNX on CPU. Chosen because it needs no new heavy
dependency (onnxruntime is already here for Smart Turn), it is trained on
English rather than a Mandarin-first corpus, and CAM++ reaches near ECAPA/TitaNet
accuracy at a fraction of the cost.

Verification, not diarization. There is one enrolled voice and the question is
accept or reject -- no need to segment a meeting.

Two thresholds on purpose:

  CONVERSE  lenient. A false reject here just means she ignored you once, which
            is annoying. Being strict would make her feel broken.
  WRITE     strict. A false accept here lets someone else answer your agents.
            An annoying re-prompt is much cheaper than a wrong permanent write.

IMPORTANT: this is a FILTER, not a CREDENTIAL. Measured separation between the
enrolled speaker's own varied speech and a similar-sounding other voice was only
about 0.12, and voice is replayable in a way a password is not. It should stop
the room's background conversation and the television from driving her; it
should not be the only thing standing between a visitor and a permanent write to
the factory. The spoken confirm gate stays regardless.
"""
from __future__ import annotations

import json
import os
import pathlib

import numpy as np

from .protocol import MIC_SR

MODEL = pathlib.Path(__file__).resolve().parent.parent / "models" / "campplus_en.onnx"
PRINT_PATH = pathlib.Path(os.environ.get(
    "BOOMER_VOICEPRINT", pathlib.Path.home() / ".boomer" / "voiceprint.json"))

# Cosine similarity thresholds. MEASURED, then raised:
#
# Enrolling one Kokoro voice and probing four others gave 0.903 for the enrolled
# speaker, 0.067-0.195 for three clearly different voices, and 0.648 for another
# American female voice -- which passed the original 0.58 write threshold. A
# false accept there means someone else answering your agents.
#
# The awkward part is the margin: enrolment self-similarity bottomed out at
# 0.769, so his own varied speech and a similar impostor are only ~0.12 apart.
# That is too thin to treat voice as AUTHORISATION. It is a filter, not a
# credential -- see the note on the write path below.
#
# Recalibrate per microphone and room with scripts/enroll.py; these defaults are
# a starting point, not a finding about Franko's voice.
CONVERSE = 0.45      # rejects the clearly-different voices, keeps her responsive
WRITE = 0.72         # above the observed impostor, below enrolment self-similarity

MIN_SECONDS = 0.6          # below this an embedding is noise


class Speaker:
    """Extracts voiceprints and compares them to the enrolled one."""

    def __init__(self) -> None:
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(MODEL), sess_options=so,
                                            providers=["CPUExecutionProvider"])
        self.enrolled = self._load()

    # --- embedding ---------------------------------------------------------
    @staticmethod
    def _fbank(audio: np.ndarray) -> np.ndarray:
        """80-dim Kaldi fbank, global-mean normalised, as the model metadata asks."""
        import torch
        from torchaudio.compliance import kaldi
        wav = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).unsqueeze(0)
        feat = kaldi.fbank(wav, num_mel_bins=80, sample_frequency=MIC_SR,
                           dither=0.0, energy_floor=0.0)
        feat = feat - feat.mean(dim=0, keepdim=True)     # feature_normalize_type
        return feat.numpy()[None, :, :]

    def embed(self, audio: np.ndarray) -> np.ndarray | None:
        """L2-normalised 512-d voiceprint, or None if the clip is too short."""
        audio = np.asarray(audio, dtype=np.float32)
        if len(audio) < MIN_SECONDS * MIC_SR:
            return None
        feat = self._fbank(audio)
        out = self.session.run(None, {"x": feat})[0][0]
        n = np.linalg.norm(out)
        return out / n if n else None

    # --- enrolment ---------------------------------------------------------
    def enroll(self, clips: list[np.ndarray]) -> tuple[np.ndarray | None, dict]:
        """Average several clips into one voiceprint. Returns (print, report).

        The report carries the pairwise agreement between clips: if a speaker's
        own samples do not agree with each other, the enrolment is bad and no
        threshold will save it.
        """
        embs = [e for e in (self.embed(c) for c in clips) if e is not None]
        if len(embs) < 2:
            return None, {"error": "need at least two usable clips"}
        sims = [float(np.dot(a, b)) for i, a in enumerate(embs) for b in embs[i + 1:]]
        centroid = np.mean(embs, axis=0)
        centroid /= np.linalg.norm(centroid)
        return centroid, {"clips": len(embs),
                          "self_similarity_min": round(min(sims), 3),
                          "self_similarity_mean": round(sum(sims) / len(sims), 3)}

    def save(self, voiceprint: np.ndarray, report: dict) -> None:
        PRINT_PATH.parent.mkdir(parents=True, exist_ok=True)
        PRINT_PATH.write_text(json.dumps(
            {"model": MODEL.name, "dim": len(voiceprint),
             "voiceprint": [round(float(x), 6) for x in voiceprint],
             "enrolment": report}, indent=2))
        self.enrolled = voiceprint

    def _load(self) -> np.ndarray | None:
        try:
            d = json.loads(PRINT_PATH.read_text())
            v = np.asarray(d["voiceprint"], dtype=np.float32)
            return v / np.linalg.norm(v)
        except Exception:
            return None

    # --- verification ------------------------------------------------------
    def similarity(self, audio: np.ndarray) -> float | None:
        """Cosine similarity to the enrolled voice, or None if not comparable."""
        if self.enrolled is None:
            return None
        e = self.embed(audio)
        return None if e is None else float(np.dot(e, self.enrolled))

    def check(self, audio: np.ndarray, strict: bool = False) -> tuple[bool, float | None]:
        """(accepted, similarity). Accepts everything when nobody is enrolled --
        a voiceprint is opt-in, and failing closed would silently mute her."""
        sim = self.similarity(audio)
        if sim is None:
            return True, None
        return sim >= (WRITE if strict else CONVERSE), sim


def available() -> bool:
    return MODEL.exists()
