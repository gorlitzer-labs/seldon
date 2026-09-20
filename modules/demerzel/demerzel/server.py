"""Demerzel's runtime: the browser is her ears and mouth, this process is the rest.

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
from .attention import Attention, State as Attn
from .factory import Item, Urgency, Watcher
from .speaker import GUEST, Speaker, available as speaker_available

WATCH_INTERVAL_S = 2.0

# One browser at a time. ears/brain/voice are module-level singletons: a second
# session would call ears.open() and wipe the first speaker's buffer, and both
# would share one KV cache, so each would hear replies to the other's questions.
# Turns serialise on the single GPU thread, so this never crashed -- it was just
# quietly wrong, which is worse. Refusing is honest until the models are
# per-session (they are 20.5 GB, so they will not be).
_active: dict = {"session": None}

# Writes Demerzel can make: resolving a factory decision is permanent, and memory
# is durable. Off behind a shared link.
READONLY = os.environ.get("DEMERZEL_READONLY", "").lower() in {"1", "true", "yes"}
# Bind host for the UI + websocket. Default loopback (this machine only). Set
# DEMERZEL_HOST to a tailnet IP to reach the voice from your phone — the web
# client already dials the websocket at the page's own host, so serving the page
# on that address is enough. Consider DEMERZEL_READONLY when exposing it.
HOST = os.environ.get("DEMERZEL_HOST", "127.0.0.1")
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="demerzel-gpu")

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
        # Enrolment reuses the endpointer that already segments utterances, so
        # "read three phrases" costs no new audio plumbing.
        self.enrolling: dict | None = None
        # Her name opens a session, not a turn. See demerzel/attention.py.
        self.attention = Attention()

    # --- emitting back to the page (called from the worker thread) ---
    def emit(self, message: dict) -> None:
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(message)), self.loop)

    def emit_audio(self, audio: np.ndarray) -> None:
        # One frame, one coroutine. Sending a JSON header and the payload as two
        # independent coroutines did not guarantee ordering: two headers could
        # land before their payloads, and the client dropped the orphaned one.
        asyncio.run_coroutine_threadsafe(
            self.ws.send(P.audio_frame(audio)), self.loop)

    def should_stop(self) -> bool:
        return self.stop_flag

    def emit_attention(self, reason: str = "") -> None:
        left = self.attention.seconds_left()
        self.emit(P.msg("attention", state=self.attention.state.value,
                        secondsLeft=None if left == float("inf") else round(left),
                        reason=reason))

    async def speak_now(self, line: str) -> None:
        """Say one line unprompted. No LLM: the text is already written."""
        if self.busy:
            return
        self.busy = True
        loop = asyncio.get_running_loop()
        try:
            self.emit(P.msg("announce", id="", kind="timer", hive="", text=line))
            self.emit(P.state(State.SPEAKING))
            await loop.run_in_executor(worker, self._say, line)
        except Exception as e:
            self.emit(P.error("speak", f"{type(e).__name__}: {e}"))
        finally:
            self.emit(P.state(State.IDLE))
            self.attention.touch()
            self.busy = False
            self.ep.reset()

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
            # Remember what she raised, so "answer SQLite" has a referent, and
            # open the window: she started this, so you should not have to say
            # her name to reply to it.
            self.ctx["last_decision"] = {"id": item.id, "hive": item.hive}
            self.attention.state = Attn.OPEN
            self.attention._extend()
            self.emit_attention("she raised it")
            line = item.spoken()
            self.emit(P.msg("announce", id=item.id, kind=item.kind,
                            hive=item.hive, text=line))
            self.emit(P.state(State.SPEAKING))
            await loop.run_in_executor(worker, self._say, line)
        except Exception as e:
            self.emit(P.error("announce", f"{type(e).__name__}: {e}"))
        finally:
            self.emit(P.state(State.IDLE))
            self.attention.touch()
            self.emit_attention("she spoke")
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
                if self.enrolling is not None:
                    await self.collect_sample()
                else:
                    await self.start_turn()

    # --- enrolment ----------------------------------------------------------
    ENROL_PHRASES = [
        "Demerzel, what is on the board this morning?",
        "Is anything blocked or waiting on me right now?",
        "Remember that I prefer short answers.",
    ]

    def begin_enrolment(self, name: str, role: str) -> None:
        self.enrolling = {"name": name, "role": role, "clips": []}
        self.emit(P.msg("enrol", stage="start", name=name, role=role,
                        phrases=self.ENROL_PHRASES))

    async def collect_sample(self) -> None:
        """One captured utterance becomes an enrolment sample."""
        e = self.enrolling
        audio = self.last_utterance
        loop = asyncio.get_running_loop()
        if audio is not None and len(audio) >= 0.6 * 16_000:
            e["clips"].append(audio)
        self.ep.reset()
        need = len(self.ENROL_PHRASES)
        self.emit(P.msg("enrol", stage="progress", got=len(e["clips"]), need=need))
        if len(e["clips"]) < need:
            return
        try:
            vp, report = await loop.run_in_executor(
                worker, functools.partial(speaker.enroll, e["clips"]))
            if vp is None:
                self.emit(P.msg("enrol", stage="failed", detail=report.get("error", "unusable")))
            else:
                profile = await loop.run_in_executor(
                    worker, functools.partial(speaker.save, e["name"], vp, report, e["role"]))
                self.emit(P.msg("enrol", stage="done", name=profile["name"],
                                role=profile["role"], report=report,
                                roster=speaker.roster()))
                print(f"  enrolled | {profile['name']} ({profile['role']}) | {report}",
                      flush=True)
        except Exception as ex:
            self.emit(P.error("enrol", f"{type(ex).__name__}: {ex}"))
        finally:
            self.enrolling = None
            self.emit(P.state(State.IDLE))

    async def start_turn(self) -> None:
        self.busy = True
        self.stop_flag = False
        loop = asyncio.get_running_loop()
        try:
            transcript = await loop.run_in_executor(worker, ears.close)
            record_utterance(self.last_utterance, transcript)
            # Who was that? Open-set, so an unenrolled voice comes back as
            # nobody rather than the nearest profile.
            if speaker is not None and self.last_utterance is not None:
                profile, sim = speaker.identify(self.last_utterance)
                self.ctx["voice_sim"] = sim
                self.ctx["speaker"] = profile
                self.ctx["may_write"] = speaker.may_write(profile, sim)
                if speaker.enrolled and profile is None:
                    self.emit(P.msg("rejected", reason="voice", similarity=sim))
                    self.emit(P.state(State.IDLE))
                    print(f"  ignored | unrecognised voice (best {sim:.3f}) | "
                          f"{transcript!r}", flush=True)
                    return
                if profile:
                    self.emit(P.msg("speaker", name=profile["name"],
                                    role=profile["role"], similarity=sim,
                                    color=profile.get("color")))

            # Is she being spoken TO? Overheard speech is logged and dropped:
            # requiring her name on every sentence would stop it being a
            # conversation, so the name opens a window instead.
            # The tool needs a way to close the window it lives in.
            self.ctx["close_attention"] = self.attention.close
            decision = self.attention.consider(transcript)
            self.emit_attention(decision.reason)
            if not decision.act:
                # An empty transcript is a VAD false start or audio she could
                # not decode -- there is nothing to show, and logging it left
                # blank bubbles in the transcript.
                if decision.reason != "empty" and transcript.strip():
                    self.emit(P.msg("overheard", text=transcript,
                                    reason=decision.reason))
                    print(f"  overheard | {decision.reason} | {transcript!r}", flush=True)
                self.emit(P.state(State.IDLE))
                return
            if decision.reason == "dismissed":
                # A dismissal needs an acknowledgement, not a generated reply.
                self.emit(P.transcript(transcript, final=True))
                self.emit(P.state(State.SPEAKING))
                await loop.run_in_executor(worker, self._say, "Right. I will be here.")
                self.emit(P.state(State.IDLE))
                print(f"  dismissed | {transcript!r}", flush=True)
                return
            self.emit(P.transcript(transcript, final=True))
            transcript = decision.text
            await loop.run_in_executor(worker, functools.partial(
                run_turn, ears, brain, voice,
                transcript=transcript, speech_ended_at=self.speech_ended_at,
                emit=self.emit, emit_audio=self.emit_audio,
                should_stop=self.should_stop, ctx=self.ctx))
            # The clock starts when she stops talking, not when he started.
            self.attention.touch()
            self.emit_attention("turn done")
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
    from .skills.timers import due_now
    while True:
        try:
            # A due reminder is the same shape as an agent escalation: something
            # happened, she says so unprompted, and the window opens so the
            # reply needs no wake word.
            for t in due_now():
                while session.busy:
                    await asyncio.sleep(0.4)
                session.attention.state = Attn.OPEN
                session.attention._extend()
                session.emit_attention("timer")
                await session.speak_now(
                    f"Time is up{', ' + t.label if t.label else ''}.")
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
            "busy", detail="Another session already has Demerzel. "
                           "Close the other tab and reload.")))
        await ws.close()
        return
    s = Session(ws, loop)
    _active["session"] = s
    s.emit(P.state(State.IDLE))
    s.emit_attention("connected")
    s.emit(P.msg("ready", hangoverMs=s.ep.hangover_ms, readonly=READONLY,
                 wakeWord="demerzel",
                 voiceCheck=bool(speaker and speaker.enrolled),
                 voices=speaker.roster() if speaker else [],
                 canEnrol=speaker is not None))
    watcher_task = asyncio.create_task(watch_factory(s))
    try:
        async for message in ws:
            if isinstance(message, bytes):
                await s.on_pcm(message)
            else:
                data = json.loads(message)
                t = data.get("type")
                if t == "enrol":
                    if speaker is None:
                        s.emit(P.msg("enrol", stage="failed",
                                     detail="speaker model not installed"))
                    else:
                        s.begin_enrolment(data.get("name", "unnamed"),
                                          data.get("role", GUEST))
                elif t == "enrol_cancel":
                    s.enrolling = None
                    s.emit(P.msg("enrol", stage="cancelled"))
                elif t == "voices":
                    s.emit(P.msg("roster", voices=speaker.roster() if speaker else []))
                elif t == "forget_voice":
                    ok = bool(speaker and speaker.forget(data.get("name", "")))
                    s.emit(P.msg("roster", voices=speaker.roster() if speaker else [],
                                 removed=ok))
                elif data.get("type") == "stop":
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
    with socketserver.TCPServer((HOST, HTTP_PORT), h) as httpd:
        httpd.serve_forever()


def load_speaker():
    """Voiceprint check. Optional: absent model or no enrolment means she
    answers everyone, which is the right default for something opt-in."""
    global speaker
    if not speaker_available():
        print("speaker: model absent, voice checks disabled", flush=True)
        return
    speaker = Speaker()
    # `enrolled` is a bool now, not a nullable array -- `is not None` was always
    # true and logged "enrolled" with an empty store.
    names = [p["name"] for p in speaker.profiles]
    print(f"speaker: {', '.join(names) if names else 'nobody enrolled yet'}", flush=True)


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
    where = "localhost" if HOST in ("127.0.0.1", "") else HOST
    print(f"\n  Demerzel is listening -- open http://{where}:{HTTP_PORT}/\n", flush=True)
    async with websockets.serve(handler, HOST, WS_PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye", flush=True)
