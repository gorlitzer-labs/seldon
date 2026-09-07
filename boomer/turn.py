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
from . import factory as fac
from . import memory as mem
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


def _speak_chunks(line: str):
    from .models import Voice
    return Voice.split(line)


def _handle_factory(transcript: str, ctx: dict) -> str | None:
    """Board queries and decision answers. Returns what to say, or None.

    The confirmation gate lives here. `factory decide` is the only write Boomer
    makes to the factory, resolveDecision() has no un-resolve path, and the input
    is speech-to-text that was measured turning "Postgres" into "poskers". So an
    answer is never filed on first utterance: it is read back, and only a plain
    yes commits it.
    """
    awaiting = ctx.get("awaiting_confirm")

    # 1. We asked for confirmation last turn; this utterance decides it.
    if awaiting:
        if fac.is_affirmative(transcript):
            ctx.pop("awaiting_confirm", None)
            if _readonly():
                return "I am in read-only mode, so I did not send that."
            ok, line = fac.answer_decision(awaiting["id"], awaiting["answer"])
            return line
        if fac.is_negative(transcript):
            ctx.pop("awaiting_confirm", None)
            return "Cancelled. Nothing was sent."
        # Anything else is treated as a correction, not a confirmation: a
        # decision must never be filed because someone said something ambiguous.
        revised = fac.detect_answer(transcript)
        if revised:
            awaiting["answer"] = revised
            return f"Changed to {revised}. Shall I send that?"
        return f"I still have {awaiting['answer']}. Yes to send, or no to cancel."

    # 2. An explicit answer to whatever she last raised.
    answer = fac.detect_answer(transcript)
    if answer:
        target = ctx.get("last_decision")
        if not target:
            return "There is nothing waiting on your call right now."
        ctx["awaiting_confirm"] = {"id": target["id"], "answer": answer,
                                   "hive": target.get("hive", "")}
        where = f" on {target['hive']}" if target.get("hive") else ""
        return f"You want to answer {answer}{where}. Shall I send that?"

    # 3. Read the board.
    if fac.is_board_query(transcript):
        return fac.board_spoken(fac.board_state())
    return None


def _readonly() -> bool:
    import os
    return os.environ.get("BOOMER_READONLY", "").lower() in {"1", "true", "yes"}


def _handle_memory(intent: str, payload: str) -> str:
    """Do the memory operation and return exactly what should be said back."""
    if intent == "remember":
        if _readonly():
            return "I am in read-only mode, so I cannot save that."
        item = mem.remember(payload)
        if item is None:
            return "I already had that, or there was nothing to store."
        # Read back the stored text verbatim: the input came from speech-to-text,
        # which was measured turning "Postgres" into "poskers".
        return f"Noted: {item.text}."
    if intent == "forget":
        if _readonly():
            return "I am in read-only mode, so I cannot change what I remember."
        dropped = mem.forget(payload)
        if not dropped:
            return "I had nothing matching that."
        if len(dropped) == 1:
            return f"Forgotten: {dropped[0].text}."
        return f"Forgotten {len(dropped)} things about that."
    if intent == "recall":
        items = mem.load()
        if not items:
            return "You have not asked me to remember anything yet."
        if len(items) <= 4:
            return "I remember: " + "; ".join(i.text for i in items) + "."
        recent = "; ".join(i.text for i in items[-3:])
        return f"I remember {len(items)} things. The latest are: {recent}."
    return "I did not follow that."


def run_turn(ears, brain, voice, *, transcript: str, speech_ended_at: float,
             emit: Emit, emit_audio: EmitAudio, should_stop: Callable[[], bool],
             ctx: dict | None = None) -> Metrics:
    """Blocking. Call on a worker thread; emit callbacks marshal back to the loop."""
    m = Metrics()
    m.stt_ms = (time.perf_counter() - speech_ended_at) * 1000
    emit(P.transcript(transcript, final=True))

    if not transcript:
        emit(P.state(State.IDLE))
        return m

    # Memory intents never reach the LLM: they are a file write and a read-back,
    # which is both faster and auditable. The write is reversible ("forget
    # that"), so unlike answering a factory decision it does not need a
    # confirmation gate BEFORE writing -- reading back what was stored is enough,
    # and far less irritating than a yes/no prompt on every note.
    ctx = {} if ctx is None else ctx
    intent, payload = mem.detect(transcript)
    line = _handle_memory(intent, payload) if intent != "none" else _handle_factory(transcript, ctx)
    if line is not None:
        emit(P.reply(line))
        emit(P.state(State.SPEAKING))
        for chunk in _speak_chunks(line):
            for audio in voice.say(chunk):
                if should_stop():
                    break
                emit_audio(audio)
        m.total_ms = (time.perf_counter() - speech_ended_at) * 1000
        m.reply_chars = len(line)
        emit(P.reply("", done=True))
        emit(m.as_msg())
        emit(P.state(State.IDLE))
        print(f"  direct | {intent if intent != 'none' else 'factory'} | {line!r}", flush=True)
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
    print(f"  turn | heard {transcript!r} | stt {m.stt_ms:.0f}ms "
          f"ttft {m.ttft_ms:.0f}ms first-audio {m.tts_first_ms:.0f}ms "
          f"| said {reply_text[:60]!r}", flush=True)
    m.reply_chars = len(reply_text)
    m.total_ms = ((first_audio_at or time.perf_counter()) - speech_ended_at) * 1000
    emit(P.reply("", done=True))
    emit(m.as_msg())
    emit(P.state(State.IDLE))
    return m
