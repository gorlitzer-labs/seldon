"""Semantic endpointing: has the user actually finished, or just paused?

A fixed VAD hangover has to choose between cutting people off mid-thought and
feeling sluggish after they clearly stopped. Demerzel's 600 ms compromise was the
single largest slice of perceived latency -- 576 of ~1956 ms.

Smart Turn v3 listens to the waveform (not the transcript) and predicts whether
the turn is complete: an 8M-param Whisper-tiny encoder with a linear head,
8.7 MB int8 ONNX, ~12 ms on CPU. Benchmarked at 92.6% overall accuracy and
94.3% on English by its authors.

The point is asymmetric: when it says "complete" we can endpoint after a short
silence, and when it says "incomplete" we WAIT LONGER than the old fixed timer
instead of interrupting. Faster on finished sentences, more patient on pauses.

Preprocessing mirrors pipecat's own inference.py exactly -- Whisper feature
extractor with chunk_length=8, padded to max_length, do_normalize=True. A
mismatch here does not error, it just returns confident nonsense.
"""
from __future__ import annotations

import numpy as np

from .protocol import MIC_SR

REPO = "pipecat-ai/smart-turn-v3"
FILENAME = "smart-turn-v3.2-cpu.onnx"
WINDOW_S = 8


class SmartTurn:
    """Predicts whether an utterance sounds finished."""

    def __init__(self) -> None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor

        path = hf_hub_download(REPO, FILENAME)
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(path, sess_options=so,
                                            providers=["CPUExecutionProvider"])
        self.fx = WhisperFeatureExtractor(chunk_length=WINDOW_S)
        self._is_logits = self.session.get_outputs()[0].name.lower().startswith("logit")

    @staticmethod
    def _sigmoid(x: float) -> float:
        return 1.0 / (1.0 + np.exp(-x))

    def probability(self, audio: np.ndarray) -> float:
        """P(turn is complete) for float32 mono audio at MIC_SR.

        The v3.2 export names its output `logits`, while pipecat's reference
        inference.py (written against v3.1) treats the value as an already
        sigmoided probability. We squash only if the graph says logits, so
        whichever is true we return a probability. NOTE: this has not been
        validated against real speech -- see the caveat on the class.
        """
        audio = np.asarray(audio, dtype=np.float32)
        n = WINDOW_S * MIC_SR
        audio = audio[-n:] if len(audio) > n else audio      # keep the END
        feats = self.fx(audio, sampling_rate=MIC_SR, return_tensors="np",
                        padding="max_length", max_length=n, truncation=True,
                        do_normalize=True).input_features
        feats = np.expand_dims(feats.squeeze(0).astype(np.float32), axis=0)
        out = self.session.run(None, {"input_features": feats})
        raw = float(out[0][0].item())
        return self._sigmoid(raw) if self._is_logits else raw

    def is_complete(self, audio: np.ndarray, threshold: float = 0.5) -> bool:
        return self.probability(audio) >= threshold

    def warm(self) -> None:
        self.probability(np.zeros(MIC_SR, dtype=np.float32))
