"""The wire contract between Boomer's brain and her face.

One definition, three consumers: the Python pipeline emits these, the web page
renders them, and the three.js avatar will drive its poses from the same
`State` values. Keeping it here means the avatar never re-invents the vocabulary.

Transport is a single websocket carrying both JSON and binary:
  client -> server   binary = microphone PCM, int16 mono 16 kHz
  server -> client   binary = synthesized speech, float32 mono 24 kHz
  both ways          JSON   = the messages below
"""
from __future__ import annotations

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


def audio_header(samples: int, sr: int = TTS_SR) -> dict:
    """Announces the binary frame that follows immediately after."""
    return msg("audio", samples=samples, sampleRate=sr)


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
