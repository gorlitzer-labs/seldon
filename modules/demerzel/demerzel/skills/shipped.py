"""Skill: what shipped. Recent merges on a project, and whether what is installed on
this Mac matches the Seldon repo. Read-only, and local only.

"Fully local" means no outbound socket at all (see demerzel/__init__.py), so this never
fetches: it reads the clones already on disk, and says how old that picture is. Live CI
and deploy status need the network and are deliberately not here -- she says so.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import time

from ..identity import find_monorepo
from ..tools import Tool, register
from .factory import resolve_project

GIT_TIMEOUT_S = 5
# The published packages in the monorepo: (spoken name, package dir, npm name).
PACKAGES = [
    ("apiary", "modules/apiary", "@gorlitzer-labs/apiary"),
    ("foundation", "modules/foundation", "@gorlitzer-labs/foundation"),
    ("comb", "modules/comb", "@gorlitzer-labs/comb"),
    ("factory", "modules/factory", "@gorlitzer-labs/factory"),
    ("seldon", "tools/seldon", "@gorlitzer-labs/seldon"),
]


def _git(repo: pathlib.Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                             timeout=GIT_TIMEOUT_S,
                             env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except (subprocess.SubprocessError, OSError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def spoken_ago(seconds: float) -> str:
    s = max(0, int(seconds))
    for unit, n in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if s >= n:
            k = s // n
            return f"{k} {unit}{'s' if k != 1 else ''} ago"
    return "just now"


def clean_subject(s: str) -> str:
    """A commit subject as it should be said: no PR number, no conventional prefix."""
    s = re.sub(r"\s*\(#\d+\)\s*$", "", s)
    s = re.sub(r"^[a-z]+(\([^)]*\))?!?:\s*", "", s)
    return s.strip()


def _default_branch(repo: pathlib.Path) -> str | None:
    head = _git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if head:
        return head
    for b in ("origin/main", "origin/master"):
        if _git(repo, "rev-parse", "--verify", "--quiet", b) is not None:
            return b
    return None


SELF_NAMES = {"seldon", "demerzel", "yourself", "you", "thestack", "stack"}


def what_shipped(project: str) -> str:
    repo = resolve_project(project)
    if repo is None and re.sub(r"[^a-z]", "", (project or "").lower()) in SELF_NAMES:
        repo = find_monorepo()     # her own repo, even before it is adopted into the factory
    if repo is None:
        return f"I could not find a project called {project}."
    if _git(repo, "rev-parse", "--git-dir") is None:
        return f"{project} is not a git repository."
    branch = _default_branch(repo)
    if branch is None:
        return f"{project} has no remote branch I can read, so nothing has shipped that I can see."
    log = _git(repo, "log", branch, "-n", "3", "--format=%s%x1f%ct") or ""
    items = [l.split("\x1f") for l in log.splitlines() if "\x1f" in l]
    if not items:
        return f"{project} has no commits on {branch}."
    now = time.time()
    first = f"Last on {project}, {spoken_ago(now - int(items[0][1]))}: {clean_subject(items[0][0])}."
    rest = [clean_subject(s) for s, _ in items[1:]]
    parts = [first]
    if rest:
        parts.append("Before that: " + "; ".join(rest) + ".")
    fetch_head = repo / ".git" / "FETCH_HEAD"
    if fetch_head.exists():
        parts.append(f"That is as of the last fetch, {spoken_ago(now - fetch_head.stat().st_mtime)}.")
    return " ".join(parts)


def _global_roots() -> list[pathlib.Path]:
    home = pathlib.Path.home()
    roots = [pathlib.Path(os.environ["PNPM_HOME"]) / "global" / "5" / "node_modules"] if os.environ.get("PNPM_HOME") else []
    roots += [home / "Library" / "pnpm" / "global" / "5" / "node_modules",
              home / ".local" / "share" / "pnpm" / "global" / "5" / "node_modules",
              home / ".bun" / "install" / "global" / "node_modules"]
    for cmd in (["npm", "root", "-g"],):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=GIT_TIMEOUT_S)
            if out.returncode == 0 and out.stdout.strip():
                roots.append(pathlib.Path(out.stdout.strip()))
        except (subprocess.SubprocessError, OSError):
            pass
    return roots


def _version(pj: pathlib.Path) -> str | None:
    try:
        return json.loads(pj.read_text()).get("version")
    except (OSError, ValueError):
        return None


def installed_version(npm_name: str, roots: list[pathlib.Path] | None = None) -> str | None:
    for r in roots if roots is not None else _global_roots():
        v = _version(r / npm_name / "package.json")
        if v:
            return v
    return None


def compare_versions(repo: pathlib.Path, roots: list[pathlib.Path] | None = None) -> str:
    roots = roots if roots is not None else _global_roots()
    behind, missing, ok = [], [], 0
    for spoken, rel, npm_name in PACKAGES:
        want = _version(repo / rel / "package.json")
        if not want:
            continue
        have = installed_version(npm_name, roots)
        if have is None:
            missing.append(spoken)
        elif have != want:
            behind.append(f"{spoken} is {have} here but the repo has {want}")
        else:
            ok += 1
    if not behind and not missing:
        return f"All {ok} installed tools match the repo."
    parts = []
    if behind:
        parts.append("; ".join(behind) + ".")
    if missing:
        parts.append("Not installed: " + ", ".join(missing) + ".")
    return " ".join(parts)


def stack_versions() -> str:
    repo = find_monorepo()
    if repo is None:
        return "I could not find the Seldon repo on this Mac, so I cannot compare versions."
    return compare_versions(repo)


register(
    Tool("what_shipped",
         "What recently merged on a software project, newest first, and how fresh that "
         "picture is. Local only: it cannot see CI or deploys.",
         {"project": {"type": "string", "description": "Project name, e.g. stranded or seldon"}},
         ["project"], what_shipped,
         lambda project="", **_: f"Checking what shipped on {project}."),
    Tool("stack_versions",
         "Whether the Seldon tools installed on this Mac match the versions in the Seldon repo.",
         {}, [], stack_versions, lambda **_: "Comparing installed versions."),
)
