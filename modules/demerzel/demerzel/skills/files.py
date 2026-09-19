"""Skill: her own machine's files. Read and find, never write.

Bounded to roots the user actually works in. An assistant that can read any path
is an exfiltration tool with a microphone attached, and she has no business
writing files from a transcript that has been measured mangling words.
"""
from __future__ import annotations

import os
import pathlib

from ..tools import Tool, register

ROOTS = [pathlib.Path(p).expanduser().resolve() for p in
         os.environ.get("DEMERZEL_FILE_ROOTS",
                        str(pathlib.Path.home() / "Desktop")).split(":")]
MAX_CHARS = 4000
MAX_HITS = 12
SKIP = {".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next"}


def _allowed(p: pathlib.Path) -> bool:
    return any(p == r or r in p.parents for r in ROOTS)


def read_file(path: str) -> str:
    p = pathlib.Path(path).expanduser()
    try:
        p = p.resolve()
    except OSError:
        return "That path does not resolve."
    if not _allowed(p):
        return "That file is outside the folders I am allowed to read."
    if not p.is_file():
        return "That is not a file I can read."
    try:
        text = p.read_text(errors="replace")
    except OSError as e:
        return f"Could not read it: {type(e).__name__}."
    if len(text) > MAX_CHARS:
        return text[:MAX_CHARS] + f"\n[truncated, {len(text)} characters total]"
    return text or "That file is empty."


def find_files(name: str) -> str:
    """Find files by name fragment. Spoken answers must be short, so it counts
    matches and names only the first few."""
    frag = (name or "").strip().lower()
    if len(frag) < 2:
        return "Give me at least two characters to search for."
    hits: list[pathlib.Path] = []
    for root in ROOTS:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
            for f in filenames:
                if frag in f.lower():
                    hits.append(pathlib.Path(dirpath) / f)
                    if len(hits) > 200:
                        break
            if len(hits) > 200:
                break
    if not hits:
        return f"Nothing matching {frag}."
    head = ", ".join(str(h.relative_to(
        next(r for r in ROOTS if r == h or r in h.parents))) for h in hits[:MAX_HITS])
    more = f" and {len(hits) - MAX_HITS} more" if len(hits) > MAX_HITS else ""
    return f"{len(hits)} match: {head}{more}."


register(
    Tool("read_file", "Read a text file on this machine, under an allowed folder.",
         {"path": {"type": "string", "description": "Absolute or ~ path"}},
         ["path"], read_file,
         lambda path="", **_: f"Reading {pathlib.Path(path).name}."),
    Tool("find_files", "Find files on this machine whose name contains a fragment.",
         {"name": {"type": "string", "description": "Part of a filename"}},
         ["name"], find_files,
         lambda name="", **_: f"Searching for {name}."),
)
