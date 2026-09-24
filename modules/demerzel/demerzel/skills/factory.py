"""Skill: the agent factory. One capability among several, not her identity."""
from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess

from ..factory import board_spoken, board_state
from ..tools import TIMEOUT_S, Tool, register

def _foundation_cmd() -> list[str]:
    """The installed `foundation`, else npx it from npm. Resolved per call, so installing
    it later is picked up. (It used to be `npx github:gorlitzer-labs/foundation` -- that
    standalone repo was retired into the monorepo, so every queue/status call failed.)"""
    return ["foundation"] if shutil.which("foundation") else ["npx", "-y", "@gorlitzer-labs/foundation"]
ROOTS = [pathlib.Path(p).expanduser().resolve() for p in
         os.environ.get("DEMERZEL_FILE_ROOTS",
                        str(pathlib.Path.home() / "Desktop")).split(":")]


def _foundation(args: list[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.run(_foundation_cmd() + args, capture_output=True, text=True,
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


# --- creating and staffing a line ------------------------------------------
# Franko chose apiary as the harness. Which agent CLI apiary launches is a
# config choice, not a hardcoded one: `claude` is what factory's own docs use
# and is the strongest at code, `opencode` against a local endpoint keeps the
# agents on this machine. Naming it here rather than burying it means the
# cloud-versus-local decision stays visible.
AGENT_HARNESS = os.environ.get("DEMERZEL_AGENT_HARNESS", "claude")


def _factory(args: list[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.run(["factory"] + args, capture_output=True, text=True,
                             timeout=180, cwd=cwd)
    except subprocess.TimeoutExpired:
        return "That took too long and I gave up."
    except OSError:
        return "The factory command is not installed on this machine."
    return (out.stdout or out.stderr or "").strip() or "No output."


def new_project(idea: str) -> str:
    """Run the deterministic front of the line: repo, seam, seed, hive.

    No confirmation: a stray directory from a mis-heard idea is untidy, not
    expensive, and asking every time would make the useful case tedious.
    """
    what = " ".join((idea or "").split())
    if len(what) < 8:
        return "Tell me a bit more about what it should be."
    # No --dir on purpose. factory new already defaults to
    # ~/Desktop/<slug-of-idea>, which is where his projects live. Reading the
    # source saved a bad bug here: --dir is the FULL project directory, not a
    # parent, so passing the projects root would have run `foundation init`
    # into ~/Desktop itself.
    out = _factory(["new", what])
    # The CLI prints a warm block; she should say the outcome, not read it out.
    if "line is warm" in out:
        name = re.search(r"new line:\s*(\S+)", out)
        return (f"Created {name.group(1) if name else 'the project'} with a hive. "
                "Say the word and I will put a coordinator in it.")
    return out.splitlines()[-1][:200] if out else "I could not tell if that worked."


def start_coordinator(project: str) -> str:
    """Put an agent in a project's hive so queued work gets picked up.

    Confirmed before running, because this starts a real agent session that
    writes code and, on a cloud harness, costs money.

    Goes through `factory staff`, which writes the room invite before launching.
    Launching `apiary <harness> Coordinator` directly started an agent that never
    joined the hive -- it only auto-joins when an invite is waiting for it.
    """
    d = resolve_project(project)
    if d is None:
        return f"I could not find a project called {project}."
    if not shutil.which("factory"):
        return "The factory is not installed, so I cannot staff a hive."
    out = _factory(["staff", str(d), "--agent", AGENT_HARNESS, "--no-wait"])
    if "already running" in out:
        return f"A coordinator is already working on {project}."
    if "started" in out:
        return (f"Started a {AGENT_HARNESS} coordinator on {project}. "
                "It will plan the queue and dispatch. I will tell you when it needs you.")
    return out.splitlines()[-1][:200] if out else "I could not tell if that worked."


register(
    Tool("new_project",
         "Create a new software project: repository, Foundation seam and an "
         "apiary hive. Use when asked to start, create or build something new.",
         {"idea": {"type": "string",
                   "description": "One sentence describing what to build"}},
         ["idea"], new_project,
         lambda idea="", **_: "Setting up the project and its hive.", writes=True),
    Tool("start_coordinator",
         "Put a coordinator agent in a project's hive so queued work is picked "
         "up and built. Use when asked to actually start the work.",
         {"project": {"type": "string", "description": "Project name"}},
         ["project"], start_coordinator,
         lambda project="", **_: f"Start a coordinator on {project}",
         writes=True, confirm=True),
)
