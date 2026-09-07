"""Skill: the agent factory. One capability among several, not her identity."""
from __future__ import annotations

import os
import pathlib
import re
import subprocess

from ..factory import board_spoken, board_state
from ..tools import TIMEOUT_S, Tool, register

FOUNDATION = ["npx", "-y", "github:gorlitzer-labs/foundation"]
ROOTS = [pathlib.Path(p).expanduser().resolve() for p in
         os.environ.get("BOOMER_FILE_ROOTS",
                        str(pathlib.Path.home() / "Desktop")).split(":")]


def _foundation(args: list[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.run(FOUNDATION + args, capture_output=True, text=True,
                             timeout=TIMEOUT_S, cwd=cwd)
    except subprocess.TimeoutExpired:
        return "That took too long and I gave up."
    except OSError as e:
        return f"Could not run foundation: {type(e).__name__}."
    return (out.stdout or out.stderr or "").strip() or "No output."


def _hives() -> list[dict]:
    st = board_state()
    return [{"name": h["name"], "dir": h["dir"]} for h in st.get("hives", [])] if st else []


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def resolve_project(name: str) -> pathlib.Path | None:
    """Match a spoken project name against hives, then against the roots."""
    want = _slug(name)
    if not want:
        return None
    for h in _hives():
        if _slug(h["name"]) == want:
            return pathlib.Path(h["dir"])
    for root in ROOTS:
        if not root.exists():
            continue
        for child in sorted(root.iterdir()):
            if child.is_dir() and _slug(child.name) == want:
                return child
    return None


def board() -> str:
    return board_spoken(board_state())


def projects() -> str:
    hives = _hives()
    if hives:
        return "The factory knows " + ", ".join(h["name"] for h in hives) + "."
    seams = [c.name for root in ROOTS if root.exists()
             for c in sorted(root.iterdir()) if (c / "docs" / "QUEUE.md").exists()]
    if not seams:
        return "No hives registered, and I found no projects with a Foundation seam."
    return ("No hives registered yet. Projects with a Foundation seam: "
            + ", ".join(seams[:12]) + ".")


def project_status(project: str) -> str:
    d = resolve_project(project)
    return _foundation(["status"], cwd=str(d)) if d else f"I could not find {project}."


def queue_work(project: str, text: str, priority: str = "P2") -> str:
    d = resolve_project(project)
    if d is None:
        return f"I could not find a project called {project}."
    pr = (priority or "P2").upper()
    if pr not in {"P1", "P2", "P3"}:
        pr = "P2"
    # The seam validates ASCII at write time, so strip what speech-to-text may
    # have introduced rather than letting foundation reject the whole write.
    item = " ".join((text or "").split()).encode("ascii", "ignore").decode().strip()
    if not item:
        return "That did not survive as plain text, so I did not queue it."
    return _foundation(["queue", f"({pr}) {item}"], cwd=str(d))


register(
    Tool("board", "The factory board: hives, blockers, and decisions pending the human's call.",
         {}, [], board, lambda **_: "Checking the board."),
    Tool("projects", "Which software projects exist and which the factory knows about.",
         {}, [], projects, lambda **_: "Looking at what projects exist."),
    Tool("project_status", "Queue, done count and phase progress for one project.",
         {"project": {"type": "string", "description": "Project name, e.g. netreach"}},
         ["project"], project_status,
         lambda project="", **_: f"Reading the {project} status."),
    Tool("queue_work",
         "Add a work item to a software project's queue. Use when asked to note, "
         "queue or add a piece of WORK for a project.",
         {"project": {"type": "string", "description": "Project name"},
          "text": {"type": "string", "description": "The work item, one sentence"},
          "priority": {"type": "string", "enum": ["P1", "P2", "P3"]}},
         ["project", "text"], queue_work,
         lambda project="", **_: f"Adding that to the {project} queue.", writes=True),
)
