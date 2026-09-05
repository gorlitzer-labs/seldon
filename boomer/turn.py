"""One conversational turn: transcript in, speech out.

The whole design goal is that these stages overlap rather than queue. The LLM
streams tokens; as soon as a short opening clause exists it goes to Kokoro and
starts playing, while the rest of the reply is still being generated. Waiting
for the full reply before synthesizing would cost about a second.
"""
from __future__ import annotations

import re
import time
from typing import Callable

import numpy as np

from . import protocol as P
from .protocol import Metrics, State

Emit = Callable[[dict], None]
EmitAudio = Callable[[np.ndarray], None]

_BOUNDARY = re.compile(r"[.!?,;:]")


class ClauseBuffer:
    """Accumulates streamed tokens and releases speakable chunks.

    The first chunk is deliberately released early and short -- Kokoro
    synthesizes a whole chunk before emitting any audio, so the opener sets the
    time-to-first-word. Later chunks are allowed to be longer because they are
    synthesized while earlier audio is still playing.
    """

    def __init__(self, opener_words: int = 5, later_words: int = 14) -> None:
        self.buf = ""
        self.first_done = False
        self.opener_words = opener_words
        self.later_words = later_words

    def push(self, text: str) -> list[str]:
        self.buf += text
        out = []
        while True:
            chunk = self._take()
            if chunk is None:
                break
            out.append(chunk)
        return out

    def _take(self) -> str | None:
        limit = self.later_words if self.first_done else self.opener_words
        words = self.buf.split()
        if not words:
            return None
        m = list(_BOUNDARY.finditer(self.buf))
        # Release at a punctuation boundary once we have a couple of words...
        if m and len(self.buf[:m[0].end()].split()) >= 2:
            cut = m[0].end()
        # ...or when the buffer has grown past the word limit, at a space.
        elif len(words) > limit:
            cut = len(" ".join(words[:limit])) + 1
        else:
            return None
        chunk, self.buf = self.buf[:cut].strip(), self.buf[cut:]
        if not chunk:
            return None
        self.first_done = True
        return chunk

    def flush(self) -> str | None:
        chunk, self.buf = self.buf.strip(), ""
        self.first_done = True
        return chunk or None


def run_turn(ears, brain, voice, *, transcript: str, speech_ended_at: float,
             emit: Emit, emit_audio: EmitAudio, should_stop: Callable[[], bool]) -> Metrics:
    """Blocking. Call on a worker thread; emit callbacks marshal back to the loop."""
    m = Metrics()
    m.stt_ms = (time.perf_counter() - speech_ended_at) * 1000
    emit(P.transcript(transcript, final=True))

    if not transcript:
        emit(P.state(State.IDLE))
        return m

    emit(P.state(State.THINKING))
    buf = ClauseBuffer()
    first_token_at = None
    first_audio_at = None
    spoken = []

    def speak(chunk: str) -> None:
        nonlocal first_audio_at
        for audio in voice.say(chunk):
            if should_stop():
                return
            if first_audio_at is None:
                first_audio_at = time.perf_counter()
                m.tts_first_ms = (first_audio_at - speech_ended_at) * 1000
                emit(P.state(State.SPEAKING))
            emit_audio(audio)

    for piece in brain.stream(transcript):
        if should_stop():
            break
        if first_token_at is None:
            first_token_at = time.perf_counter()
            m.ttft_ms = (first_token_at - speech_ended_at) * 1000
        for chunk in buf.push(piece):
            spoken.append(chunk)
            emit(P.reply(chunk))
            speak(chunk)

    tail = buf.flush()
    if tail and not should_stop():
        spoken.append(tail)
        emit(P.reply(tail))
        speak(tail)

    reply_text = " ".join(spoken)
    m.reply_chars = len(reply_text)
    m.total_ms = ((first_audio_at or time.perf_counter()) - speech_ended_at) * 1000
    emit(P.reply("", done=True))
    emit(m.as_msg())
    emit(P.state(State.IDLE))
    return m
