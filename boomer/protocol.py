"""The wire contract between Boomer's brain and her face.

One definition, three consumers: the Python pipeline emits these, the web page
renders them, and the three.js avatar will drive its poses from the same
`State` values. Keeping it here means the avatar never re-invents the vocabulary.

Transport is a single websocket carrying both JSON and binary:
  client -> server   binary = microphone PCM, int16 mono 16 kHz
  server -> client   binary = one AUDIO FRAME (see below)
  both ways          JSON   = the messages below

An audio frame is SELF-DESCRIBING: an 8-byte little-endian header
(uint32 sampleRate, uint32 sampleCount) followed by that many float32 samples.

It used to be a JSON header message followed by a separate binary frame, which
was a race: the two were dispatched as independent coroutines, so two headers
could arrive before their payloads, the client's pending header was overwritten,
and the second payload was silently dropped -- an audible gap mid-sentence.
One frame cannot be mispaired.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, asdict, field
from enum import Enum

MIC_SR = 16_000     # what the STT and VAD expect
TTS_SR = 24_000     # what Kokoro emits
WS_PORT = 8765
HTTP_PORT = 8770


class State(str, Enum):
    """What Boomer is doing. The avatar maps each of these to a pose."""
    IDLE = "idle"           # dormant, sitting
    LISTENING = "listening" # speech detected, capturing
    THINKING = "thinking"   # transcribing or generating
    SPEAKING = "speaking"   # audio is playing


def msg(type_: str, **fields) -> dict:
    return {"type": type_, **fields}


def state(s: State) -> dict:
    return msg("state", value=s.value)


def transcript(text: str, final: bool) -> dict:
    return msg("transcript", text=text, final=final)


def reply(text: str, done: bool = False) -> dict:
    return msg("reply", text=text, done=done)


AUDIO_HEADER = struct.Struct("<II")     # sampleRate, sampleCount


def audio_frame(audio, sr: int = TTS_SR) -> bytes:
    """One self-describing binary frame: header + float32 samples."""
    import numpy as np
    a = np.asarray(audio, dtype=np.float32)
    return AUDIO_HEADER.pack(sr, len(a)) + a.tobytes()


def error(where: str, detail: str) -> dict:
    return msg("error", where=where, detail=detail)


@dataclass
class Metrics:
    """Per-turn latency breakdown. The whole point of the project is this staying small."""
    stt_ms: float = 0.0
    ttft_ms: float = 0.0          # LLM time to first token
    tts_first_ms: float = 0.0     # time from turn start to first audio sample
    total_ms: float = 0.0         # end of speech -> first audio out
    reply_chars: int = 0

    def as_msg(self) -> dict:
        return msg("metrics", **{k: round(v, 1) if isinstance(v, float) else v
                                 for k, v in asdict(self).items()})
