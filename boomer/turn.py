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
from . import tools as T
from .protocol import Metrics, State

Emit = Callable[[dict], None]
EmitAudio = Callable[[np.ndarray], None]

# A sentence ender is always a safe place to break: Kokoro renders each chunk
# with a terminal contour, which is correct there and wrong anywhere else.
_SENTENCE = re.compile(r"[.!?]")
# A comma is only used when a sentence runs long enough that waiting for its end
# would delay first audio more than a slightly odd break costs. Whether Kokoro
# gives a trailing comma a continuation contour is untested by ear, so this is
# deliberately the fallback and not the default.
_CLAUSE = re.compile(r"[,;:]")


class ClauseBuffer:
    """Accumulates streamed tokens and releases speakable chunks.

    Chunks are released ONLY at punctuation. An earlier version also cut at a
    word count to get first audio out sooner, and that was the wrong trade:
    Kokoro synthesizes every chunk as a complete utterance with a falling
    terminal contour, so "I am here when you need me." was cut into

        "I am here when you"   +   "need me."

    and spoken as two finished sentences with an audible hole between them.
    Franko heard it as "I am here when you ....... need me". No amount of
    scheduling fixes that -- the pause is in the prosody, not the timing.

    So a clause boundary is a punctuation mark, full stop. The cost is that
    first audio waits for the first real clause (~395 ms rather than ~330 ms on
    a short one), which is a price worth paying for not sounding broken.
    """

    # Only a runaway sentence with no punctuation at all should ever be cut on
    # length, and then at a word boundary as a last resort.
    RUNAWAY_WORDS = 30       # no punctuation at all: cut as a last resort
    LONG_SENTENCE = 12       # past this, a comma beats waiting
    MIN_WORDS = 3

    def __init__(self, min_words: int = MIN_WORDS) -> None:
        self.buf = ""
        self.min_words = min_words

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
        words = self.buf.split()
        if not words:
            return None
        # Sentence enders first, always.
        for m in _SENTENCE.finditer(self.buf):
            cut = m.end()
            # A boundary only counts once there is enough before it to be worth
            # speaking; "I." is not a clause.
            if len(self.buf[:cut].split()) >= self.min_words:
                return self._cut(cut)
        # Only once the sentence is long does a comma become the better break.
        if len(words) > self.LONG_SENTENCE:
            for m in _CLAUSE.finditer(self.buf):
                cut = m.end()
                if len(self.buf[:cut].split()) >= self.min_words:
                    return self._cut(cut)
        if len(words) > self.RUNAWAY_WORDS:
            return self._cut(len(" ".join(words[:self.RUNAWAY_WORDS])) + 1)
        return None

    def _cut(self, at: int) -> str | None:
        chunk, self.buf = self.buf[:at].strip(), self.buf[at:]
        return chunk or None

    def flush(self) -> str | None:
        chunk, self.buf = self.buf.strip(), ""
        return chunk or None


T_MAX_STEPS = 4          # she must speak eventually


def _narrate(line: str, emit, emit_audio, voice, should_stop) -> None:
    """Say what she is about to do, so a slow tool is never silence.

    Franko asked for this directly: tell him to wait, and keep telling him what
    is happening. `foundation` runs through npx and takes seconds, so this fires
    for real rather than being decoration.
    """
    if not line:
        return
    emit(P.reply(line))
    emit(P.state(State.SPEAKING))
    for chunk in _speak_chunks(line):
        if should_stop():
            return
        for audio in voice.say(chunk):
            emit_audio(audio)
    emit(P.state(State.THINKING))


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
            # A permanent write needs a confident OWNER match. A recognised
            # guest can talk to her all day and still not answer someone else's
            # agents.
            if ctx.get("may_write") is False:
                who = (ctx.get("speaker") or {}).get("name")
                if who:
                    return (f"Sorry {who}, only Franko can answer the factory. "
                            "Nothing was sent.")
                return ("I am not confident enough that this is you to answer "
                        "for you. Do it from the terminal.")
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

    # Board questions used to be answered by a keyword match here, which
    # shadowed the `board` tool entirely and stopped her reasoning about it or
    # combining it with anything else. Tools own that now; it costs an extra
    # generation round trip and buys uniformity.
    return None


def _readonly() -> bool:
    import os
    return os.environ.get("BOOMER_READONLY", "").lower() in {"1", "true", "yes"}


def _handle_memory(intent: str, payload: str, ctx: dict | None = None) -> str:
    """Do the memory operation and return exactly what should be said back."""
    if intent == "remember":
        if _readonly():
            return "I am in read-only mode, so I cannot save that."
        if ctx is not None and ctx.get("may_write") is False:
            return "Only Franko can change what I remember."
        item = mem.remember(payload)
        if item is None:
            return "I already had that, or there was nothing to store."
        # Read back the stored text verbatim: the input came from speech-to-text,
        # which was measured turning "Postgres" into "poskers".
        return f"Noted: {item.text}."
    if intent == "forget":
        if _readonly():
            return "I am in read-only mode, so I cannot change what I remember."
        if ctx is not None and ctx.get("may_write") is False:
            return "Only Franko can change what I remember."
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
    line = (_handle_memory(intent, payload, ctx) if intent != "none"
            else _handle_factory(transcript, ctx))
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

    def generate(prompt: str) -> str:
        """Stream one generation, speaking clauses, and return the raw text.

        Once a tool call starts, stop SPEAKING but keep generating. An earlier
        version broke out of the loop at "<tool_call>", which truncated the call
        before its closing tags and left it unparseable -- the model produced
        '<tool_call><function=projects></function>' and she said nothing at all.
        """
        nonlocal first_token_at
        raw = ""
        in_call = False
        for piece in brain.stream(prompt):
            if should_stop():
                break
            if first_token_at is None:
                first_token_at = time.perf_counter()
                m.ttft_ms = (first_token_at - speech_ended_at) * 1000
            raw += piece
            if not in_call and T.looks_like_call(raw):
                in_call = True          # markup is never spoken
            if in_call:
                continue
            for chunk in buf.push(piece):
                spoken.append(chunk)
                emit(P.reply(chunk))
                speak(chunk)
        return raw

    def generate_tool(wrapped: str) -> str:
        """Same as generate(), but feeding a tool response back in."""
        nonlocal first_token_at
        raw, in_call = "", False
        for piece in brain.stream_tool_result(wrapped):
            if should_stop():
                break
            raw += piece
            if not in_call and T.looks_like_call(raw):
                in_call = True
            if in_call:
                continue
            for chunk in buf.push(piece):
                spoken.append(chunk)
                emit(P.reply(chunk))
                speak(chunk)
        return raw

    # Tools run in a loop: she may need the board before she can answer about
    # it. Bounded, because a model that keeps calling tools would never speak.
    raw = generate(transcript)
    for _ in range(T_MAX_STEPS):
        calls = T.parse_calls(raw)
        if not calls:
            break
        # Anything she wrote before the call is not for speaking -- it is
        # usually "let me check that", which the narration says better.
        buf.buf = ""
        for call in calls:
            emit(P.msg("tool", name=call.name, args=call.args))
            result = T.execute_narrated(
                call, may_write=ctx.get("may_write", True),
                narrate=lambda line: _narrate(line, emit, emit_audio, voice, should_stop))
            print(f"  tool | {call.name} {call.args} -> {result[:70]!r}", flush=True)
            raw = generate_tool(T.render_response(call.name, result))

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
