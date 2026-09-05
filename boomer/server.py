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

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="boomer-gpu")

ears: Ears
brain: Brain
voice: Voice


class Session:
    """One connected browser."""

    def __init__(self, ws, loop):
        self.ws = ws
        self.loop = loop
        self.ep = Endpointer()
        self.busy = False          # a turn is running
        self.stop_flag = False
        self.speech_ended_at = 0.0

    # --- emitting back to the page (called from the worker thread) ---
    def emit(self, message: dict) -> None:
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(message)), self.loop)

    def emit_audio(self, audio: np.ndarray) -> None:
        a = np.asarray(audio, dtype=np.float32)
        self.emit(P.audio_header(len(a)))
        asyncio.run_coroutine_threadsafe(self.ws.send(a.tobytes()), self.loop)

    def should_stop(self) -> bool:
        return self.stop_flag

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
                await self.start_turn()

    async def start_turn(self) -> None:
        self.busy = True
        self.stop_flag = False
        loop = asyncio.get_running_loop()
        try:
            transcript = await loop.run_in_executor(worker, ears.close)
            self.emit(P.transcript(transcript, final=False))
            await loop.run_in_executor(worker, functools.partial(
                run_turn, ears, brain, voice,
                transcript=transcript, speech_ended_at=self.speech_ended_at,
                emit=self.emit, emit_audio=self.emit_audio,
                should_stop=self.should_stop))
        except Exception as e:                       # never wedge the session
            self.emit(P.error("turn", f"{type(e).__name__}: {e}"))
            self.emit(P.state(State.IDLE))
        finally:
            self.busy = False
            self.ep.reset()


async def handler(ws):
    loop = asyncio.get_running_loop()
    s = Session(ws, loop)
    s.emit(P.state(State.IDLE))
    s.emit(P.msg("ready", hangoverMs=s.ep.hangover_ms))
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


def serve_http():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=WEB_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", HTTP_PORT), h) as httpd:
        httpd.serve_forever()


def load_models():
    global ears, brain, voice
    ears, brain, voice = load_all()


async def main():
    load_models()
    threading.Thread(target=serve_http, daemon=True).start()
    print(f"\n  Boomer is listening -- open http://localhost:{HTTP_PORT}/\n", flush=True)
    async with websockets.serve(handler, "127.0.0.1", WS_PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye", flush=True)
