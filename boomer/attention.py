"""When is Boomer being spoken TO, rather than merely spoken NEAR?

Requiring a wake word on every sentence is unusable -- it stops being a
conversation. So the wake word opens a SESSION, not a turn:

    CLOSED  she hears everything and acts on nothing until her name is said.
    OPEN    follow-ups need no wake word. Every exchange extends the window.
            "that's all" closes it. "stay with me" removes the timeout.

That is the shape Alexa and Google both converged on independently, which is
reasonable evidence it is right, and it is what the Reddit build's "that'll be
all" dismissal was reaching for.

The trigger is her NAME IN THE TRANSCRIPT, not an acoustic wake-word model.
openWakeWord ships alexa / hey_mycroft / hey_jarvis / hey_rhasspy and nothing
for "boomer"; a custom model is hours of synthesis and augmentation for
uncertain recall (the build that inspired this got 0.22 on synthetic test data).
Meanwhile she already transcribes every utterance, so gating on the transcript
costs nothing new and uses her actual name today.

What a trained model WOULD buy is skipping STT entirely while closed -- roughly
300 ms of GPU per overheard utterance. That is an optimisation, not the feature,
so `Attention.wake_detected` stays the seam to swap it in behind.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum

WINDOW_S = 25.0          # follow-ups need no wake word for this long
NAME = "boomer"

# Tolerant of what speech-to-text actually returns: "Boomer," "boomer" and the
# near-misses a recogniser produces for a two-syllable name.
_WAKE = re.compile(r"\b(hey\s+|ok(ay)?\s+|yo\s+)?(boomer|bloomer|boomber|bumer)\b", re.I)
_CLOSE = re.compile(
    r"\b(that'?s all|that will be all|that'?ll be all|thanks?( you)?,? boomer|"
    r"dismissed|nothing else|we'?re done|go to sleep|stand down)\b", re.I)
_HOLD = re.compile(
    r"\b(stay with me|keep listening|stay awake|stay open|don'?t go)\b", re.I)


class State(str, Enum):
    CLOSED = "closed"       # her name is required
    OPEN = "open"           # follow-ups accepted
    HELD = "held"           # open with no timeout, until dismissed


@dataclass
class Decision:
    act: bool
    state: State
    text: str = ""          # the utterance with the wake word stripped
    reason: str = ""        # for logging and the UI, never for the model


@dataclass
class Attention:
    window_s: float = WINDOW_S
    state: State = State.CLOSED
    open_until: float = 0.0
    _now: object = field(default=time.monotonic, repr=False)

    # --- queries -----------------------------------------------------------
    def is_open(self) -> bool:
        if self.state is State.HELD:
            return True
        if self.state is State.OPEN and self._now() < self.open_until:
            return True
        return False

    def seconds_left(self) -> float:
        if self.state is State.HELD:
            return float("inf")
        return max(0.0, self.open_until - self._now()) if self.state is State.OPEN else 0.0

    @staticmethod
    def wake_detected(transcript: str) -> bool:
        """The seam an acoustic wake-word model would replace."""
        return bool(_WAKE.search(transcript or ""))

    # --- the decision ------------------------------------------------------
    def consider(self, transcript: str) -> Decision:
        """Should she act on this utterance, and what is the remaining text?"""
        text = " ".join((transcript or "").split())
        if not text:
            return Decision(False, self.state, reason="empty")

        # Expire a stale window before anything else, so a dismissal or a wake
        # word is evaluated against the true state.
        if self.state is State.OPEN and not self.is_open():
            self.state = State.CLOSED

        # Dismissal works whenever she is listening, and never wakes her.
        if _CLOSE.search(text):
            if self.is_open():
                self.state = State.CLOSED
                self.open_until = 0.0
                return Decision(True, self.state, text=text, reason="dismissed")
            return Decision(False, self.state, reason="dismissed while closed")

        woken = self.wake_detected(text)

        if _HOLD.search(text) and (self.is_open() or woken):
            self.state = State.HELD
            return Decision(True, self.state, text=self._strip(text), reason="held open")

        if self.is_open():
            self._extend()
            return Decision(True, self.state, text=self._strip(text), reason="in window")

        if woken:
            self.state = State.OPEN
            self._extend()
            # Her name is an address, not content. "Boomer, what's on the
            # board?" must reach the model as "what's on the board?".
            stripped = self._strip(text)
            return Decision(True, self.state, text=stripped or "yes?", reason="woken")

        return Decision(False, State.CLOSED, reason="not addressed")

    # --- internals ---------------------------------------------------------
    def _extend(self) -> None:
        if self.state is State.OPEN:
            self.open_until = self._now() + self.window_s

    @staticmethod
    def _strip(text: str) -> str:
        """Remove the address, and the punctuation that only held it in place.

        Naive removal leaves debris the model then has to interpret:
        "Hello, Boomer, how you doing?" became "Hello, , how you doing?" -- a
        real transcript from Franko's first conversation.
        """
        out = _WAKE.sub("\x00", text, count=1)
        # Collapse the punctuation on BOTH sides of where the name was, keeping
        # at most one separator.
        out = re.sub(r"\s*[,;:]?\s*\x00\s*[,;:]?\s*", lambda m: (
            ", " if "," in m.group(0) and not m.group(0).strip().startswith("\x00") else " "
        ), out)
        out = re.sub(r"^\s*[,.:;!?\-]+\s*", "", out)          # nothing leads with punctuation
        out = re.sub(r"\s+([,.:;!?])", r"\1", out)             # no space before punctuation
        out = re.sub(r"([,;:])\s*([,.;:!?])", r"\2", out)      # no doubled separators
        return " ".join(out.split()).strip()

    def close(self) -> None:
        self.state = State.CLOSED
        self.open_until = 0.0
