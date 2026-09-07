"""Boomer's runtime: the browser is her ears and mouth, this process is the rest.

The page captures microphone audio with echo cancellation on (measured at
26.8 dB ERLE, which is why Python needs no CoreAudio binding), streams it here
as 16 kHz int16, and plays back the float32 speech we send in return. The same
socket carries the state events the avatar will eventually render.

Model calls are blocking and share one GPU, so they run on a single worker
thread; callbacks marshal results back onto the event loop.
"""
from __future__ import annotations

import asyncio
import functools
import http.server
import json
import os
import socketserver
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import websockets

from . import protocol as P
from .audio import Endpointer, int16_to_float
from .models import Brain, Ears, Voice
from .runtime import load_all
from .protocol import HTTP_PORT, WS_PORT, State
from .turn import run_turn
from .record import record_utterance
from .factory import Item, Urgency, Watcher
from .speaker import Speaker, available as speaker_available

WATCH_INTERVAL_S = 2.0

# One browser at a time. ears/brain/voice are module-level singletons: a second
# session would call ears.open() and wipe the first speaker's buffer, and both
# would share one KV cache, so each would hear replies to the other's questions.
# Turns serialise on the single GPU thread, so this never crashed -- it was just
# quietly wrong, which is worse. Refusing is honest until the models are
# per-session (they are 20.5 GB, so they will not be).
_active: dict = {"session": None}

# Writes Boomer can make: resolving a factory decision is permanent, and memory
# is durable. Off behind a shared link.
READONLY = os.environ.get("BOOMER_READONLY", "").lower() in {"1", "true", "yes"}
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="boomer-gpu")

ears: Ears
brain: Brain
voice: Voice
speaker: Speaker | None = None


class Session:
    """One connected browser."""

    def __init__(self, ws, loop):
        self.ws = ws
        self.loop = loop
        self.ep = Endpointer()
        self.busy = False          # a turn is running
        self.stop_flag = False
        self.speech_ended_at = 0.0
        self.last_utterance = None
        self.batched: list[Item] = []
        self.ctx: dict = {}          # cross-turn state (last decision, pending confirm)

    # --- emitting back to the page (called from the worker thread) ---
    def emit(self, message: dict) -> None:
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(message)), self.loop)

    def emit_audio(self, audio: np.ndarray) -> None:
        a = np.asarray(audio, dtype=np.float32)
        self.emit(P.audio_header(len(a)))
        asyncio.run_coroutine_threadsafe(self.ws.send(a.tobytes()), self.loop)

    def should_stop(self) -> bool:
        return self.stop_flag

    async def announce(self, item: Item) -> None:
        """Speak a factory escalation. TTS only -- no LLM, no transcript.

        The agent already wrote this text for a human to read, so there is
        nothing to generate. That is what makes proactive announcements
        essentially free, and what would let them keep working even with the
        brain unloaded.
        """
        if self.busy:
            return
        self.busy = True
        loop = asyncio.get_running_loop()
        try:
            # Remember what she raised, so "answer SQLite" has a referent.
            self.ctx["last_decision"] = {"id": item.id, "hive": item.hive}
            line = item.spoken()
            self.emit(P.msg("announce", id=item.id, kind=item.kind,
                            hive=item.hive, text=line))
            self.emit(P.state(State.SPEAKING))
            await loop.run_in_executor(worker, self._say, line)
        except Exception as e:
            self.emit(P.error("announce", f"{type(e).__name__}: {e}"))
        finally:
            self.emit(P.state(State.IDLE))
            self.busy = False
            self.ep.reset()

    def _say(self, line: str) -> None:
        for chunk in Voice.split(line):
            if self.stop_flag:
                return
            for audio in voice.say(chunk):
                self.emit_audio(audio)

    # --- microphone input ---
    async def on_pcm(self, blob: bytes) -> None:
        # Half-duplex for now: ignore the mic while she is speaking. Barge-in is
        # queued to run off the wake word, which tolerates the 14 dB SNR that
        # full transcription would not.
        if self.busy:
            return
        pcm = int16_to_float(blob)
        for kind, frame in self.ep.push(pcm):
            if kind == "start":
                ears.open()
                ears.feed(frame)
                self.emit(P.state(State.LISTENING))
            elif kind == "audio":
                ears.feed(frame)
            elif kind == "abort":
                ears.close()
                self.emit(P.state(State.IDLE))
            elif kind == "end":
                self.speech_ended_at = time.perf_counter()
                self.last_utterance = self.ep.utterance_audio()
                await self.start_turn()

    async def start_turn(self) -> None:
        self.busy = True
        self.stop_flag = False
        loop = asyncio.get_running_loop()
        try:
            transcript = await loop.run_in_executor(worker, ears.close)
            self.emit(P.transcript(transcript, final=False))
            record_utterance(self.last_utterance, transcript)
            # Score the voice once per turn and hand it to the turn, so the
            # factory write can demand a stricter match than conversation does.
            if speaker is not None and self.last_utterance is not None:
                ok, sim = speaker.check(self.last_utterance, strict=False)
                self.ctx["voice_sim"] = sim
                if not ok:
                    self.emit(P.msg("rejected", reason="voice", similarity=sim))
                    self.emit(P.state(State.IDLE))
                    print(f"  ignored | not Franko (similarity {sim:.3f}) | "
                          f"{transcript!r}", flush=True)
                    return
            await loop.run_in_executor(worker, functools.partial(
                run_turn, ears, brain, voice,
                transcript=transcript, speech_ended_at=self.speech_ended_at,
                emit=self.emit, emit_audio=self.emit_audio,
                should_stop=self.should_stop, ctx=self.ctx))
        except Exception as e:                       # never wedge the session
            self.emit(P.error("turn", f"{type(e).__name__}: {e}"))
            self.emit(P.state(State.IDLE))
        finally:
            self.busy = False
            self.ep.reset()


async def watch_factory(session: "Session") -> None:
    """Poll the factory's decision queue and speak what is worth interrupting for.

    An mtime stat every couple of seconds -- idle CPU measured at 0.0%, so this
    costs nothing until something actually happens. Existing items are primed as
    seen at startup: being greeted by a backlog is how an assistant gets muted.
    """
    watcher = Watcher()
    watcher.prime()
    while True:
        try:
            for item in watcher.poll():
                if item.urgency is Urgency.NOW:
                    while session.busy:            # never talk over a turn
                        await asyncio.sleep(0.4)
                    await session.announce(item)
                elif item.urgency is Urgency.BATCH:
                    session.batched.append(item)
                    session.emit(P.msg("batched", count=len(session.batched)))
        except Exception as e:
            session.emit(P.error("watcher", f"{type(e).__name__}: {e}"))
        await asyncio.sleep(WATCH_INTERVAL_S)


async def handler(ws):
    loop = asyncio.get_running_loop()
    if _active["session"] is not None:
        await ws.send(json.dumps(P.msg(
            "busy", detail="Another session already has Boomer. "
                           "Close the other tab and reload.")))
        await ws.close()
        return
    s = Session(ws, loop)
    _active["session"] = s
    s.emit(P.state(State.IDLE))
    s.emit(P.msg("ready", hangoverMs=s.ep.hangover_ms, readonly=READONLY))
    watcher_task = asyncio.create_task(watch_factory(s))
    try:
        async for message in ws:
            if isinstance(message, bytes):
                await s.on_pcm(message)
            else:
                data = json.loads(message)
                if data.get("type") == "stop":
                    s.stop_flag = True
                elif data.get("type") == "reset":
                    brain.reset()
                    s.emit(P.msg("info", detail="conversation reset"))
    except websockets.ConnectionClosed:
        pass
    finally:
        watcher_task.cancel()
        if _active["session"] is s:
            _active["session"] = None


def serve_http():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=WEB_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", HTTP_PORT), h) as httpd:
        httpd.serve_forever()


def load_speaker():
    """Voiceprint check. Optional: absent model or no enrolment means she
    answers everyone, which is the right default for something opt-in."""
    global speaker
    if not speaker_available():
        print("speaker: model absent, voice checks disabled", flush=True)
        return
    speaker = Speaker()
    print(f"speaker: {'enrolled' if speaker.enrolled is not None else 'no voiceprint yet'}",
          flush=True)


def load_models():
    """Load on the worker thread, not the main one.

    MLX streams are thread-local. Loading and warming on the main thread and
    then running turns on the executor raises

        RuntimeError: There is no Stream(cpu, 1) in current thread

    because the worker never inherits the stream the models were built against.
    Every MLX touch -- load, warm, transcribe, generate -- happens on this one
    thread, which is also what serialises access to the single GPU.
    """
    global ears, brain, voice
    ears, brain, voice = load_all()
    load_speaker()


async def main():
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(worker, load_models)   # same thread as every turn
    threading.Thread(target=serve_http, daemon=True).start()
    print(f"\n  Boomer is listening -- open http://localhost:{HTTP_PORT}/\n", flush=True)
    async with websockets.serve(handler, "127.0.0.1", WS_PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye", flush=True)
