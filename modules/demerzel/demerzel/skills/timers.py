"""Skill: timers and reminders.

The only skill that has to speak on its OWN schedule, so it reuses the
announcement path already built for factory escalations -- a due reminder is the
same shape as an agent needing a call: something happened, she should say so
unprompted, and it should open the conversation window so a reply needs no wake
word.

Persisted to disk, because a reminder that dies with the process is a reminder
that lied to you.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import time
from dataclasses import dataclass

from ..tools import Tool, register

STORE = pathlib.Path(os.environ.get(
    "DEMERZEL_TIMERS", pathlib.Path.home() / ".demerzel" / "timers.json"))
MAX_ACTIVE = 20

# "twenty minutes", "1 hour", "90 seconds", "an hour and a half"
_UNITS = {"second": 1, "seconds": 1, "sec": 1, "secs": 1,
          "minute": 60, "minutes": 60, "min": 60, "mins": 60,
          "hour": 3600, "hours": 3600, "hr": 3600, "hrs": 3600}
_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
          "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
          "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "forty-five": 45,
          "fortyfive": 45, "sixty": 60, "ninety": 90, "half": 0.5}


_UNIT_WORD = r"(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)"


def parse_duration(text: str) -> float | None:
    """Seconds from a spoken duration, or None. Speech gives words, not digits."""
    t = (text or "").lower().replace("-", " ")
    # "half an hour" matched "an hour" and silently dropped the half, so
    # normalise the fractions people actually say before scanning for numbers.
    t = re.sub(rf"\bhalf\s+(?:a|an)\s+{_UNIT_WORD}\b", r"0.5 \1", t)
    t = re.sub(rf"\b(?:a|an|one)\s+{_UNIT_WORD}\s+and\s+a\s+half\b", r"1.5 \1", t)
    t = re.sub(rf"\b([0-9]+)\s+{_UNIT_WORD}\s+and\s+a\s+half\b",
               lambda m: f"{float(m.group(1)) + 0.5} {m.group(2)}", t)
    t = re.sub(r"\band\s+a\s+half\b", "", t)
    total = 0.0
    found = False
    for m in re.finditer(r"([0-9]+(?:\.[0-9]+)?|[a-z]+)\s+(second|seconds|sec|secs|"
                         r"minute|minutes|min|mins|hour|hours|hr|hrs)\b", t):
        qty, unit = m.group(1), m.group(2)
        n = float(qty) if qty.replace(".", "").isdigit() else _WORDS.get(qty)
        if n is None:
            continue
        total += n * _UNITS[unit]
        found = True
    return total if found and total > 0 else None


@dataclass
class Timer:
    id: str
    due: float
    label: str

    def as_dict(self) -> dict:
        return {"id": self.id, "due": self.due, "label": self.label}


def _load() -> list[Timer]:
    try:
        return [Timer(**d) for d in json.loads(STORE.read_text())]
    except Exception:
        return []


def _save(items: list[Timer]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps([t.as_dict() for t in items], indent=2))


def _spoken_left(seconds: float) -> str:
    s = int(max(0, seconds))
    if s < 60:
        return f"{s} seconds"
    if s < 3600:
        m, r = divmod(s, 60)
        return f"{m} minute{'s' if m != 1 else ''}" + (f" {r} seconds" if r and m < 3 else "")
    h, r = divmod(s, 3600)
    m = r // 60
    return f"{h} hour{'s' if h != 1 else ''}" + (f" {m} minutes" if m else "")


def set_timer(duration: str, label: str = "") -> str:
    secs = parse_duration(duration)
    if secs is None:
        return "I did not catch how long. Try something like twenty minutes."
    items = [t for t in _load() if t.due > time.time()]
    if len(items) >= MAX_ACTIVE:
        return "You already have too many timers running."
    what = " ".join((label or "").split())
    tid = f"t{int(time.time() * 1000) % 1_000_000}"
    items.append(Timer(tid, time.time() + secs, what))
    _save(items)
    return (f"Set for {_spoken_left(secs)}" + (f", {what}." if what else "."))


def list_timers() -> str:
    items = sorted((t for t in _load() if t.due > time.time()), key=lambda t: t.due)
    if not items:
        return "No timers running."
    if len(items) == 1:
        t = items[0]
        return (f"One timer, {_spoken_left(t.due - time.time())} left"
                + (f", {t.label}." if t.label else "."))
    parts = [f"{_spoken_left(t.due - time.time())}" + (f" for {t.label}" if t.label else "")
             for t in items[:4]]
    return f"{len(items)} timers: " + "; ".join(parts) + "."


def cancel_timers(which: str = "") -> str:
    items = [t for t in _load() if t.due > time.time()]
    if not items:
        return "There was nothing to cancel."
    frag = " ".join((which or "").split()).lower()
    if not frag or frag in {"all", "everything"}:
        _save([])
        return f"Cancelled {len(items)} timer{'s' if len(items) != 1 else ''}."
    keep = [t for t in items if frag not in t.label.lower()]
    dropped = len(items) - len(keep)
    if not dropped:
        return f"I had no timer matching {frag}."
    _save(keep)
    return f"Cancelled {dropped}."


def due_now() -> list[Timer]:
    """Timers that have come due. Removes them, so each fires once."""
    items = _load()
    if not items:
        return []
    now = time.time()
    due = [t for t in items if t.due <= now]
    if due:
        _save([t for t in items if t.due > now])
    return due


register(
    Tool("set_timer", "Set a timer or reminder for a spoken duration.",
         {"duration": {"type": "string", "description": "e.g. twenty minutes, 90 seconds"},
          "label": {"type": "string", "description": "What it is for, optional"}},
         ["duration"], set_timer, lambda **_: "", writes=True),
    Tool("list_timers", "What timers are running and how long is left.", {}, [],
         list_timers, lambda **_: ""),
    Tool("cancel_timers", "Cancel a timer, or all of them.",
         {"which": {"type": "string", "description": "Label fragment, or all"}},
         [], cancel_timers, lambda **_: "", writes=True),
)
