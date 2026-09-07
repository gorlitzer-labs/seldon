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
STORE = pathlib.Path(os.environ.get(
    "BOOMER_VOICES", pathlib.Path.home() / ".boomer" / "voices.json"))

# Roles, not just identities. Recognising a guest is only useful if it changes
# what she will do for them: conversation is harmless, resolving someone's
# agents in their name is not.
OWNER, GUEST = "owner", "guest"

# One hue per enrolled person, assigned at enrolment and stored with the profile.
# Hashing the name was tried first and collided on the two names that mattered
# (Franko and Giulia landed on the same colour): six buckets and a weak hash is
# not a safe way to allocate identity. Round-robin over unused entries cannot
# collide until the palette is exhausted.
#
# All warm or magenta: Boomer owns the cyan band and an alert owns the red, so a
# person is never mistaken for either.
PERSON_COLORS = ["#FF9E3D", "#C08CFF", "#FFD54A", "#FF7BA8", "#E8A06A", "#B0D46A"]

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
        self.profiles = self._load()
        self._vectors = self._as_vectors()

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

    def save(self, name: str, voiceprint: np.ndarray, report: dict,
             role: str = GUEST) -> dict:
        """Add or replace a named profile. Returns the stored profile."""
        name = " ".join((name or "").split())[:40] or "unnamed"
        profiles = [p for p in self.profiles if p["name"].lower() != name.lower()]
        # The first voice enrolled is the owner: whoever set her up is the
        # person whose factory it is. Everyone after that is a guest by default.
        if not profiles and role == GUEST:
            role = OWNER
        used = {p.get("color") for p in profiles}
        free = [c for c in PERSON_COLORS if c not in used]
        profile = {"name": name, "role": role,
                   "color": (free or PERSON_COLORS)[0],
                   "voiceprint": [round(float(x), 6) for x in voiceprint],
                   "enrolment": report}
        profiles.append(profile)
        self.profiles = profiles
        STORE.parent.mkdir(parents=True, exist_ok=True)
        STORE.write_text(json.dumps({"model": MODEL.name, "profiles": profiles}, indent=2))
        self._vectors = self._as_vectors()
        return profile

    def forget(self, name: str) -> bool:
        before = len(self.profiles)
        self.profiles = [p for p in self.profiles
                         if p["name"].lower() != (name or "").strip().lower()]
        if len(self.profiles) == before:
            return False
        STORE.write_text(json.dumps({"model": MODEL.name, "profiles": self.profiles},
                                    indent=2))
        self._vectors = self._as_vectors()
        return True

    def roster(self) -> list[dict]:
        return [{"name": p["name"], "role": p["role"],
                 "color": p.get("color", PERSON_COLORS[0]),
                 "quality": p.get("enrolment", {}).get("self_similarity_min")}
                for p in self.profiles]

    def _load(self) -> list[dict]:
        try:
            return json.loads(STORE.read_text()).get("profiles", [])
        except Exception:
            return []

    def _as_vectors(self):
        out = []
        for p in self.profiles:
            v = np.asarray(p["voiceprint"], dtype=np.float32)
            n = np.linalg.norm(v)
            if n:
                out.append((p, v / n))
        return out

    # --- identification ----------------------------------------------------
    def identify(self, audio: np.ndarray) -> tuple[dict | None, float | None]:
        """(profile, similarity) for the best match above CONVERSE, else (None, sim).

        Open-set: an unenrolled speaker must come back as nobody rather than as
        the nearest profile, which is the whole point when the television is on.
        """
        if not self._vectors:
            return None, None
        e = self.embed(audio)
        if e is None:
            return None, None
        best, best_sim = None, -1.0
        for profile, vec in self._vectors:
            sim = float(np.dot(e, vec))
            if sim > best_sim:
                best, best_sim = profile, sim
        return (best if best_sim >= CONVERSE else None), best_sim

    def may_write(self, profile: dict | None, similarity: float | None) -> bool:
        """Only a confident owner match may cause an irreversible write."""
        if not self._vectors:
            return True                      # nobody enrolled: opt-in feature
        return bool(profile and profile.get("role") == OWNER
                    and similarity is not None and similarity >= WRITE)

    @property
    def enrolled(self) -> bool:
        return bool(self._vectors)

def available() -> bool:
    return MODEL.exists()
