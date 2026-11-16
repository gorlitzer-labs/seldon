"""Skill: your agents -- the same list `seldon ws` shows.

The factory skill sees hives and their decision queue. Most of the time the thing
that actually needs you is a coding agent sitting at a prompt, and only seldon
knows about those. So this skill reads seldon, never reimplements it:

    seldon lanes --json         every agent on this machine, with its state
    seldon lane read <key>      what it last said
    seldon lane say <key> TEXT  type an answer (tmux agents, only while waiting)
    seldon ws pick <key>        put it on the right of the workspace

Answering is a write into another agent's session, so it is owner-only and read
back before it is sent -- the same gate as answering a factory decision.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

from ..factory import Item, Urgency
from ..tools import Tool, register

CLI = os.environ.get("SELDON_CLI", "seldon")
TIMEOUT_S = 15


def _seldon(args: list[str]) -> tuple[bool, str]:
    try:
        out = subprocess.run([CLI, *args], capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return False, "seldon took too long."
    except OSError:
        return False, "seldon is not installed on this machine."
    text = (out.stdout or "").strip() or (out.stderr or "").strip()
    return out.returncode == 0, re.sub(r"\x1b\[[0-9;]*m", "", text)


def lanes() -> list[dict] | None:
    ok, out = _seldon(["lanes", "--json"])
    if not ok:
        return None
    try:
        data = json.loads(out.splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return None
    return data if isinstance(data, list) else None


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def find(name: str, ls: list[dict]) -> dict | None:
    """The agent she means: exact name, then project, then a word match. Never a guess
    between two -- an answer typed into the wrong agent is worse than asking again."""
    want = _norm(name)
    if not want:
        return None
    for test in (lambda l: _norm(l.get("name")) == want,
                 lambda l: _norm(l.get("projectName")) == want,
                 lambda l: want in _norm(l.get("name")) or want in _norm(l.get("projectName"))):
        hits = [l for l in ls if test(l)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            waiting = [l for l in hits if l.get("state") == "needs-you"]
            return waiting[0] if len(waiting) == 1 else None
    return None


def _label(l: dict) -> str:
    n, p = l.get("name") or "an agent", l.get("projectName") or ""
    return n if _norm(n) == _norm(p) or not p else f"{n} on {p}"


def agents_spoken(ls: list[dict] | None) -> str:
    if ls is None:
        return "I cannot reach seldon, so I cannot see your agents."
    if not ls:
        return "No agents are running."
    need = [l for l in ls if l.get("state") == "needs-you"]
    busy = sum(1 for l in ls if l.get("state") in ("working", "running"))
    parts = []
    if need:
        names = [f"{_label(l)}, {l['waitingFor']}" if l.get("waitingFor") and l["waitingFor"] != "you"
                 else _label(l) for l in need[:4]]
        parts.append(f"{len(need)} need{'s' if len(need) == 1 else ''} you: " + "; ".join(names) + ".")
    else:
        parts.append("No agent needs you.")
    if busy:
        parts.append(f"{busy} working.")
    return " ".join(parts)


def what_needs_me() -> str:
    return agents_spoken(lanes())


def _speakable(text: str, limit: int = 320) -> str:
    """The end of what it said, as speech: code and markdown out, the last paragraph kept."""
    t = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    t = re.sub(r"[`*_#>|]+", "", t)
    paras = [p.strip() for p in re.split(r"\n\s*\n", t) if p.strip()]
    t = " ".join((paras[-1] if paras else "").split())
    if len(t) > limit:
        t = "..." + t[-limit:].split(" ", 1)[-1]
    return t


def read_agent(name: str) -> str:
    ls = lanes()
    if ls is None:
        return "I cannot reach seldon."
    l = find(name, ls)
    if not l:
        return f"I could not tell which agent you mean by {name}."
    ok, out = _seldon(["lane", "read", l["key"], "--json"])
    if not ok:
        return out.splitlines()[-1][:200] if out else f"I could not read {_label(l)}."
    try:
        text = json.loads(out.splitlines()[-1]).get("text", "")
    except (json.JSONDecodeError, IndexError):
        text = out
    said = _speakable(text)
    return f"{_label(l)} says: {said}" if said else f"{_label(l)} has not said anything yet."


def tell(key: str, text: str) -> tuple[bool, str]:
    """Type an answer into an agent. Called only after the owner confirmed it."""
    ok, out = _seldon(["lane", "say", key, text])
    return ok, ("Sent." if ok else (out.splitlines()[-1][:200] if out else "That failed."))


def tell_agent(name: str, text: str) -> str:
    ls = lanes()
    if ls is None:
        return "I cannot reach seldon."
    l = find(name, ls)
    if not l:
        return f"I could not tell which agent you mean by {name}."
    return tell(l["key"], text)[1]


def open_agent(name: str) -> str:
    ls = lanes()
    l = find(name, ls or [])
    if not l:
        return f"I could not tell which agent you mean by {name}."
    ok, out = _seldon(["ws", "pick", l["key"]])
    return f"Opened {_label(l)}." if ok else "The workspace is not open. Run seldon ws first."


class AgentWatcher:
    """Notices an agent starting to wait on you. Each wait is announced once; when the
    agent moves on and later waits again, that is news again."""

    def __init__(self, read=lanes) -> None:
        self._read = read
        self._waiting: set[str] = set()

    def prime(self) -> None:
        self._waiting = {l["key"] for l in (self._read() or []) if l.get("state") == "needs-you"}

    def poll(self) -> list[Item]:
        ls = self._read()
        if ls is None:                       # seldon unreachable: change nothing
            return []
        now = {l["key"]: l for l in ls if l.get("state") == "needs-you"}
        fresh = [l for k, l in now.items() if k not in self._waiting]
        self._waiting = set(now)
        return [Item(id="lane:" + l["key"], hive=l.get("projectName") or "",
                     who=l.get("name") or "an agent",
                     text=l.get("waitingFor") if l.get("waitingFor") not in (None, "", "you") else "It is waiting for you.",
                     kind="decision", urgency=Urgency.NOW) for l in fresh]


register(
    Tool("agents",
         "Your coding agents (Claude, Codex, opencode) and which of them need you right now. "
         "Use for 'what needs me', 'how are my agents', 'is anything waiting on me'.",
         {}, [], what_needs_me, lambda **_: "Checking your agents."),
    Tool("read_agent",
         "Read out what one agent last said or is asking.",
         {"name": {"type": "string", "description": "The agent's name or its project, e.g. tars"}},
         ["name"], read_agent, lambda name="", **_: f"Reading {name}."),
    Tool("tell_agent",
         "Type an answer into an agent that is waiting for you.",
         {"name": {"type": "string", "description": "The agent's name or its project"},
          "text": {"type": "string", "description": "Exactly what to type to it"}},
         ["name", "text"], tell_agent,
         lambda name="", text="", **_: f"Tell {name}: {text}", writes=True, confirm=True),
    Tool("open_agent",
         "Show one agent in the seldon workspace on screen.",
         {"name": {"type": "string", "description": "The agent's name or its project"}},
         ["name"], open_agent, lambda name="", **_: f"Opening {name}."),
)
