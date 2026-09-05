"""Turn a stream of microphone frames into utterances.

Silero VAD decides speech vs silence per 32 ms window; a hangover timer decides
when you have finished talking. That silence timer is the single biggest
contributor to perceived latency, and it is exactly the number the Reddit build
excluded from its "~1 s mic-to-reply" figure -- so we measure it and report it.

Smart Turn v3 belongs here eventually: it reads the same VAD silence and asks
whether the sentence sounds finished, instead of just counting milliseconds.
"""
from __future__ import annotations

import numpy as np

from .protocol import MIC_SR

FRAME = 512                 # silero wants 512 samples at 16 kHz (32 ms)
SPEECH_PROB = 0.5
START_FRAMES = 2            # ~64 ms of speech to open an utterance
HANGOVER_MS = 600           # silence before we call the turn finished
MIN_UTTERANCE_MS = 300      # ignore coughs and door slams


class Endpointer:
    """Feed it audio, it tells you when an utterance starts and ends."""

    def __init__(self, hangover_ms: int = HANGOVER_MS) -> None:
        from silero_vad import load_silero_vad
        import torch
        self._torch = torch
        self.model = load_silero_vad()
        self.hangover_frames = max(1, int(hangover_ms / 1000 * MIC_SR / FRAME))
        self.reset()

    def reset(self) -> None:
        self.model.reset_states()
        self._tail = np.zeros(0, dtype=np.float32)
        self._speech_run = 0
        self._silence_run = 0
        self.active = False
        self._voiced_frames = 0

    def push(self, pcm: np.ndarray) -> list[tuple[str, np.ndarray]]:
        """Consume float32 audio; return ('start'|'audio'|'end', frame) events."""
        buf = np.concatenate([self._tail, pcm.astype(np.float32)])
        events: list[tuple[str, np.ndarray]] = []
        n = (len(buf) // FRAME) * FRAME
        for i in range(0, n, FRAME):
            frame = buf[i:i + FRAME]
            with self._torch.no_grad():
                prob = float(self.model(self._torch.from_numpy(frame), MIC_SR).item())
            voiced = prob >= SPEECH_PROB

            if not self.active:
                self._speech_run = self._speech_run + 1 if voiced else 0
                if self._speech_run >= START_FRAMES:
                    self.active = True
                    self._silence_run = 0
                    self._voiced_frames = self._speech_run
                    events.append(("start", frame))
                continue

            events.append(("audio", frame))
            self._voiced_frames += 1
            self._silence_run = 0 if voiced else self._silence_run + 1
            if self._silence_run >= self.hangover_frames:
                long_enough = (self._voiced_frames * FRAME / MIC_SR * 1000) >= MIN_UTTERANCE_MS
                self.active = False
                self._speech_run = 0
                if long_enough:
                    events.append(("end", frame))
                else:
                    events.append(("abort", frame))
        self._tail = buf[n:]
        return events

    @property
    def hangover_ms(self) -> float:
        return self.hangover_frames * FRAME / MIC_SR * 1000


def int16_to_float(buf: bytes) -> np.ndarray:
    return np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0


def float_to_int16(a: np.ndarray) -> bytes:
    return (np.clip(a, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
