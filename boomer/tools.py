"""What Boomer can actually DO, beyond talking.

Until now she could read the factory and speak. These are the first real tools,
chosen for value against risk rather than for a long list:

  board          the factory board, already proven
  projects       what the factory knows about
  project_status one project's queue, done and facts
  queue_work     add an item to a project's queue      (WRITE, owner only)
  read_file      read a file under an allowed root      (READ, bounded)

Deliberately NOT here yet:
  terminal    arbitrary execution by voice, off a transcript that has been
              measured mangling words. Needs a confirmation gate at least.
  web search  every option is an outbound request, which would break the
              loopback-only property that "fully local" currently rests on.

Two properties matter more than the tool list:

WRITES ARE OWNER ONLY. The permission comes from the identified speaker, the
same way answering a factory decision does, so a recognised guest can ask her
anything and change nothing.

TOOLS ARE SLOW ENOUGH TO NARRATE. `foundation` runs through npx and takes two to
four seconds, which is exactly why Franko asked to be told what she is doing
rather than left in silence. Each tool therefore declares `doing`, a spoken
present-tense phrase, and the turn speaks it before running.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable

from .factory import board_spoken, board_state, cli_available

FOUNDATION = ["npx", "-y", "github:gorlitzer-labs/foundation"]
TIMEOUT_S = 45

# read_file is bounded to roots the user actually works in. An assistant that
# can read any path is a data-exfiltration tool with a microphone attached.
ALLOWED_ROOTS = [pathlib.Path(p).expanduser().resolve() for p in
                 os.environ.get("BOOMER_FILE_ROOTS",
                                str(pathlib.Path.home() / "Desktop")).split(":")]
MAX_FILE_CHARS = 4000


@dataclass
class Tool:
    name: str
    description: str
    params: dict                 # JSON-schema properties
    required: list[str]
    run: Callable[..., str]
    doing: Callable[..., str]    # what she says before running it
    writes: bool = False

    def schema(self) -> dict:
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": self.params,
                           "required": self.required}}}


# --- implementations -------------------------------------------------------

def _foundation(args: list[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.run(FOUNDATION + args, capture_output=True, text=True,
                             timeout=TIMEOUT_S, cwd=cwd)
    except subprocess.TimeoutExpired:
        return "That took too long and I gave up."
    except OSError as e:
        return f"Could not run foundation: {type(e).__name__}."
    text = (out.stdout or out.stderr or "").strip()
    return text or "No output."


def _projects() -> list[dict]:
    st = board_state()
    if st:
        return [{"name": h["name"], "dir": h["dir"]} for h in st.get("hives", [])]
    return []


def _resolve_project(name: str) -> pathlib.Path | None:
    """Match a spoken project name against known hives, then against the roots."""
    want = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    if not want:
        return None
    for p in _projects():
        if re.sub(r"[^a-z0-9]", "", p["name"].lower()) == want:
            return pathlib.Path(p["dir"])
    for root in ALLOWED_ROOTS:
        for child in sorted(root.glob("*")):
            if child.is_dir() and re.sub(r"[^a-z0-9]", "", child.name.lower()) == want:
                return child
    return None


def tool_board() -> str:
    return board_spoken(board_state())


def tool_projects() -> str:
    hives = _projects()
    if hives:
        return "The factory knows " + ", ".join(h["name"] for h in hives) + "."
    dirs = [c.name for root in ALLOWED_ROOTS if root.exists()
            for c in sorted(root.glob("*")) if (c / "docs" / "QUEUE.md").exists()]
    if not dirs:
        return "No hives registered, and I found no projects with a Foundation seam."
    return ("No hives registered yet. Projects with a Foundation seam: "
            + ", ".join(dirs[:12]) + ".")


def tool_project_status(project: str) -> str:
    d = _resolve_project(project)
    if d is None:
        return f"I could not find a project called {project}."
    return _foundation(["status"], cwd=str(d))


def tool_queue_work(project: str, text: str, priority: str = "P2") -> str:
    d = _resolve_project(project)
    if d is None:
        return f"I could not find a project called {project}."
    pr = (priority or "P2").upper()
    if pr not in {"P1", "P2", "P3"}:
        pr = "P2"
    item = " ".join((text or "").split())
    if not item:
        return "There was nothing to queue."
    # The seam validates ASCII at write time, so strip what speech-to-text may
    # have introduced rather than letting foundation reject the whole write.
    item = item.encode("ascii", "ignore").decode().strip()
    if not item:
        return "That did not survive as plain text, so I did not queue it."
    return _foundation(["queue", f"({pr}) {item}"], cwd=str(d))


def tool_read_file(path: str) -> str:
    p = pathlib.Path(path).expanduser()
    try:
        p = p.resolve()
    except OSError:
        return "That path does not resolve."
    if not any(p == r or r in p.parents for r in ALLOWED_ROOTS):
        return "That file is outside the folders I am allowed to read."
    if not p.is_file():
        return "That is not a file I can read."
    try:
        text = p.read_text(errors="replace")
    except OSError as e:
        return f"Could not read it: {type(e).__name__}."
    if len(text) > MAX_FILE_CHARS:
        return text[:MAX_FILE_CHARS] + f"\n[truncated, {len(text)} chars total]"
    return text or "That file is empty."


TOOLS: dict[str, Tool] = {
    t.name: t for t in [
        Tool("board", "The factory board: hives, blockers and decisions pending the human's call.",
             {}, [], lambda: tool_board(),
             lambda **_: "Checking the board."),
        Tool("projects", "Which projects the factory knows about.",
             {}, [], lambda: tool_projects(),
             lambda **_: "Looking at what projects exist."),
        Tool("project_status",
             "Queue, done count and phase progress for one project.",
             {"project": {"type": "string", "description": "Project name, e.g. netreach"}},
             ["project"], tool_project_status,
             lambda project="", **_: f"Reading the {project} status."),
        Tool("queue_work",
             "Add a work item to a project's queue. Use when the user asks to "
             "note, queue, add or remember a piece of WORK for a project.",
             {"project": {"type": "string", "description": "Project name"},
              "text": {"type": "string", "description": "The work item, one sentence"},
              "priority": {"type": "string", "enum": ["P1", "P2", "P3"]}},
             ["project", "text"], tool_queue_work,
             lambda project="", **_: f"Adding that to the {project} queue.",
             writes=True),
        Tool("read_file", "Read a text file under an allowed folder.",
             {"path": {"type": "string", "description": "Absolute or ~ path"}},
             ["path"], tool_read_file,
             lambda path="", **_: f"Reading {pathlib.Path(path).name}."),
    ]
}


def schemas() -> list[dict]:
    return [t.schema() for t in TOOLS.values()]


# --- the call format -------------------------------------------------------
# Qwen3.6's template does NOT use JSON here. Its own instruction to the model is:
#   <tool_call>
#   <function=name>
#   <parameter=key>
#   value
#   </parameter>
#   </function>
#   </tool_call>

# The closing </tool_call> is optional on purpose: models drop it, and a call
# that parsed only when perfectly terminated meant she silently did nothing.
_CALL = re.compile(
    r"<tool_call>\s*<function=([^>\s]+)>(.*?)</function>(?:\s*</tool_call>)?",
    re.S)
_PARAM = re.compile(r"<parameter=([^>\s]+)>\s*(.*?)\s*</parameter>", re.S)


@dataclass
class Call:
    name: str
    args: dict


def parse_calls(text: str) -> list[Call]:
    out = []
    for m in _CALL.finditer(text or ""):
        args = {k: v for k, v in _PARAM.findall(m.group(2))}
        out.append(Call(m.group(1).strip(), args))
    return out


def looks_like_call(text: str) -> bool:
    """Cheap check while streaming, so generation can be cut short."""
    return "<tool_call>" in (text or "")


def render_response(name: str, result: str) -> str:
    return f"<tool_response>\n{result}\n</tool_response>"


HEARTBEAT_S = 30.0       # Franko asked for "keep telling me", not one notice


def execute_narrated(call: Call, may_write: bool,
                     narrate: Callable[[str], None]) -> str:
    """Run a tool, saying what it is before and while it happens.

    The intent is spoken up front, and if the tool is still going after
    HEARTBEAT_S a follow-up says so -- because being left in silence is the
    complaint, not the waiting itself. The timer runs on its own thread; the
    tool call itself is blocking.
    """
    import threading

    intent, _unused = _intent_only(call, may_write)
    if intent:
        narrate(intent)

    stop = threading.Event()
    said = {"n": 0}

    def beat():
        while not stop.wait(HEARTBEAT_S):
            said["n"] += 1
            narrate("Still working on that." if said["n"] == 1
                    else "Still going.")

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        _, result = execute(call, may_write)
    finally:
        stop.set()
    return result


def _intent_only(call: Call, may_write: bool) -> tuple[str, str]:
    tool = TOOLS.get(call.name)
    if tool is None:
        return "", ""
    if tool.writes and not may_write:
        return "", ""
    try:
        return tool.doing(**call.args), ""
    except Exception:
        return "Working on it.", ""


def execute(call: Call, may_write: bool) -> tuple[str, str]:
    """(spoken_intent, result). Refuses a write for anyone but the owner."""
    tool = TOOLS.get(call.name)
    if tool is None:
        return "", f"I do not have a tool called {call.name}."
    if tool.writes and not may_write:
        return "", ("Only Franko can change a project, so I did not do that.")
    try:
        intent = tool.doing(**call.args)
    except Exception:
        intent = "Working on it."
    try:
        return intent, tool.run(**{k: v for k, v in call.args.items()
                                   if k in tool.params})
    except TypeError as e:
        return intent, f"I called that wrong: {e}."
    except Exception as e:
        return intent, f"That failed: {type(e).__name__}."
