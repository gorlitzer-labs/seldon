"""Who she is and where her own code lives -- injected into the system prompt at boot.

Without this she had read access to her own source (it sits under ~/Desktop, inside
her file roots) and never used it: nothing told her it was there, or that she is one
part of a larger stack. A model does not go looking for a thing it does not know exists.

Found locally only: an explicit DEMERZEL_SOURCE, else the factory registry (a plain
JSON file, no subprocess), else a shallow look under the file roots. Never the network.
"""
from __future__ import annotations

import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent          # the code that is running now
REGISTRY = pathlib.Path.home() / ".factory" / "hives.json"
MARKER = pathlib.Path("modules") / "demerzel" / "demerzel"


def _roots() -> list[pathlib.Path]:
    return [pathlib.Path(p).expanduser() for p in
            os.environ.get("DEMERZEL_FILE_ROOTS", str(pathlib.Path.home() / "Desktop")).split(":")]


def _is_monorepo(d: pathlib.Path) -> bool:
    return (d / MARKER).is_dir()


def find_monorepo() -> pathlib.Path | None:
    """The Seldon monorepo checkout: the source of truth for her code."""
    env = os.environ.get("DEMERZEL_SOURCE")
    if env and _is_monorepo(pathlib.Path(env).expanduser()):
        return pathlib.Path(env).expanduser().resolve()
    try:
        for e in json.loads(REGISTRY.read_text()):
            d = pathlib.Path(e.get("dir") or "")
            if d.name and _is_monorepo(d):
                return d.resolve()
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    # the running copy may itself be a checkout (a dev run from the repo)
    for p in HERE.parents:
        if _is_monorepo(p):
            return p
    for root in _roots():                 # shallow: root/*/ and root/*/*/
        if not root.is_dir():
            continue
        for depth in ("*", "*/*"):
            for d in sorted(root.glob(depth)):
                if d.is_dir() and _is_monorepo(d):
                    return d.resolve()
    return None


def as_prompt() -> str:
    repo = find_monorepo()
    lines = [
        "\n\nAbout yourself: you are one part of the Seldon stack, Franko's tools for "
        "running AI agents -- apiary (rooms where agents work together), foundation "
        "(each project's queue and docs), comb (secrets), factory (creates projects and "
        "supervises their agents), bifrost (reaching other machines) and you, the voice.",
    ]
    if repo:
        lines.append(
            f" Your own source code is in {repo / 'modules' / 'demerzel'}; the whole stack "
            f"is the Seldon repo at {repo}. When asked how you work or what you can do, "
            "read it with your file tools rather than guessing.")
    lines.append(
        " You never change code yourself. Work on any project -- including you and the "
        "stack -- is queued to that project, and agents build it through pull requests.")
    return "".join(lines)
