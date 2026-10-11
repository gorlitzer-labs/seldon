"""Skill: the machine she lives on. Local, no network.

She genuinely could not tell the time before this, which is a strange gap in
something you talk to all day.

macOS control goes through osascript. Everything that CHANGES the machine is a
write, so it is owner-only -- a guest can ask what is playing and cannot pause
it. Nothing here is destructive, and lock_screen is the most disruptive thing
available on purpose: no quitting apps, no shutdown, no file writes.
"""
from __future__ import annotations

import datetime as dt
import shutil
import subprocess

from ..tools import Tool, register

TIMEOUT_S = 8


def _osa(script: str) -> str:
    if not shutil.which("osascript"):
        return ""
    try:
        out = subprocess.run(["osascript", "-e", script], capture_output=True,
                             text=True, timeout=TIMEOUT_S)
    except (subprocess.SubprocessError, OSError):
        return ""
    return (out.stdout or "").strip()


def _ordinal(n: int) -> str:
    if 11 <= n % 100 <= 13:
        return f"{n}th"
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th') }"


def time_now() -> str:
    n = dt.datetime.now()
    # Spoken, not printed. "13:07" read aloud is worse than "seven past one",
    # and "the 7 of September" is not a thing anyone says.
    return (n.strftime("It is %-I:%M %p on %A the ")
            + _ordinal(n.day) + n.strftime(" of %B."))


def battery() -> str:
    if not shutil.which("pmset"):
        return "I cannot read the battery on this machine."
    try:
        out = subprocess.run(["pmset", "-g", "batt"], capture_output=True,
                             text=True, timeout=TIMEOUT_S).stdout
    except (subprocess.SubprocessError, OSError):
        return "I could not read the battery."
    import re
    pct = re.search(r"(\d+)%", out)
    charging = "AC Power" in out or "charging" in out.lower()
    if not pct:
        return "I could not read the battery."
    return (f"Battery is at {pct.group(1)} percent"
            + (", on power." if charging else ", on battery."))


def _running(proc: str) -> bool:
    """Cheap liveness check. Asking osascript about a non-running app measured
    8 seconds for "nothing is playing", because addressing an application can
    make macOS try to start it. pgrep is instant and cannot launch anything."""
    if not shutil.which("pgrep"):
        return True
    try:
        return subprocess.run(["pgrep", "-x", proc], capture_output=True,
                              timeout=2).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def now_playing() -> str:
    for app, script in (
        ("Music", 'tell application "Music" to if it is running then '
                  'if player state is playing then return (name of current track) '
                  '& " by " & (artist of current track)'),
        ("Spotify", 'tell application "Spotify" to if it is running then '
                    'if player state is playing then return (name of current track) '
                    '& " by " & (artist of current track)'),
    ):
        if not _running(app):
            continue
        got = _osa(script)
        if got:
            return f"{got}, in {app}."
    return "Nothing is playing."


def get_volume() -> str:
    v = _osa("output volume of (get volume settings)")
    return f"Volume is at {v} percent." if v.isdigit() else "I could not read the volume."


def set_volume(level: str) -> str:
    try:
        n = max(0, min(100, int(float(level))))
    except (TypeError, ValueError):
        return "Give me a number between zero and a hundred."
    _osa(f"set volume output volume {n}")
    return f"Volume {n}."


def open_app(name: str) -> str:
    app = " ".join((name or "").split())
    if not app:
        return "Which application?"
    try:
        out = subprocess.run(["open", "-a", app], capture_output=True, text=True,
                             timeout=TIMEOUT_S)
    except (subprocess.SubprocessError, OSError):
        return f"I could not open {app}."
    if out.returncode != 0:
        return f"I could not find an application called {app}."
    return f"Opened {app}."


def lock_screen() -> str:
    _osa('tell application "System Events" to keystroke "q" '
         'using {command down, control down}')
    return "Locking."


register(
    Tool("time_now", "The current time and date.", {}, [], time_now,
         lambda **_: ""),                      # instant: nothing to narrate
    Tool("battery", "This machine's battery level and whether it is charging.",
         {}, [], battery, lambda **_: ""),
    Tool("now_playing", "What music is currently playing, if any.", {}, [],
         now_playing, lambda **_: "Checking what is playing."),
    Tool("get_volume", "The current output volume.", {}, [], get_volume,
         lambda **_: ""),
    Tool("set_volume", "Set the output volume, 0 to 100.",
         {"level": {"type": "string", "description": "0 to 100"}},
         ["level"], set_volume, lambda level="", **_: "", writes=True),
    Tool("open_app", "Open an application on this Mac.",
         {"name": {"type": "string", "description": "Application name, e.g. Safari"}},
         ["name"], open_app, lambda name="", **_: f"Opening {name}.", writes=True),
    Tool("lock_screen", "Lock this Mac's screen.", {}, [], lock_screen,
         lambda **_: "", writes=True),
)
