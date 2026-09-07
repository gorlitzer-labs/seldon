"""Reading the factory's state, and deciding what is worth interrupting for.

The factory escalates by writing to ~/.factory/decisions.json -- the schema comes
from its own src/lib/decisions.mjs:

    {id, hive, dir, from, text, kind: "decision"|"blocker", ts, status}

with pending() filtering on status === "pending". Today that queue only reaches a
human who is sitting in front of `factory board`. Boomer's whole point is that
the factory runs 24/7 and a human does not.

Announcing costs no LLM. The text was already written by an agent for a human to
read, so speaking it is TTS only -- which means proactive announcements work even
with the 18.6 GB brain unloaded.

Everything here is pure and file-reading only: no model, no network, no writes.
Answering a decision is a WRITE and deliberately lives elsewhere, behind a
read-back confirmation, because resolveDecision() has no un-resolve path.
"""
from __future__ import annotations

import json
import os
import pathlib
from dataclasses import dataclass
from enum import Enum

FACTORY_DIR = pathlib.Path(os.environ.get("FACTORY_HOME", pathlib.Path.home() / ".factory"))
DECISIONS = FACTORY_DIR / "decisions.json"


class Urgency(str, Enum):
    """What an item is worth costing you.

    The scarce resource is attention, not GPU. Idle compute is already 0.0%;
    an assistant that reads out every status change is worse than a silent one.
    """
    NOW = "now"        # speak as soon as she is not mid-turn
    BATCH = "batch"    # hold, summarise when asked or on the next natural gap
    SILENT = "silent"  # visible on the board; never worth interrupting for


@dataclass(frozen=True)
class Item:
    id: str
    hive: str
    who: str
    text: str
    kind: str
    urgency: Urgency

    def spoken(self) -> str:
        """One short sentence, read aloud. No markdown, no ids, no jargon."""
        body = self.text.split(":", 1)[-1].strip() if ":" in self.text[:12] else self.text.strip()
        body = " ".join(body.split())
        if len(body) > 220:                      # keep an interruption short
            body = body[:217].rsplit(" ", 1)[0] + "..."
        where = f" on {self.hive}" if self.hive else ""
        if self.kind == "blocker":
            return f"{self.who}{where} is blocked. {body}"
        if self.kind == "decision":
            return f"{self.who}{where} needs a call. {body}"
        return f"{self.who}{where}: {body}"      # routine; batched, rarely spoken


def classify(kind: str, text: str) -> Urgency:
    """Decide whether this is worth speaking, holding, or ignoring."""
    k = (kind or "").lower()
    if k == "blocker":
        return Urgency.NOW                       # an agent is stopped, doing nothing
    if k == "decision":
        return Urgency.NOW                       # something is gated on you
    return Urgency.BATCH


def read_decisions(path: pathlib.Path | None = None) -> list[dict]:
    """Every decision the factory has filed. Missing file is normal, not an error."""
    p = path or DECISIONS
    try:
        data = json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def pending(path: pathlib.Path | None = None) -> list[Item]:
    """Open items, most urgent first. Mirrors factory's own pending()."""
    out = []
    for d in read_decisions(path):
        if not isinstance(d, dict) or d.get("status") != "pending":
            continue
        kind = d.get("kind", "decision")
        out.append(Item(
            id=str(d.get("id", "")),
            hive=str(d.get("hive", "")),
            who=str(d.get("from", "an agent")),
            text=str(d.get("text", "")),
            kind=kind,
            urgency=classify(kind, str(d.get("text", ""))),
        ))
    order = {Urgency.NOW: 0, Urgency.BATCH: 1, Urgency.SILENT: 2}
    return sorted(out, key=lambda i: order[i.urgency])


class Watcher:
    """Notices new pending items. An mtime check, so idling costs nothing.

    Items already seen are never re-announced, including across a restart within
    the same session -- being told the same blocker twice is exactly the noise
    that makes people mute an assistant.
    """

    def __init__(self, path: pathlib.Path | None = None) -> None:
        self.path = path or DECISIONS
        self._mtime = 0.0
        self._seen: set[str] = set()

    def prime(self) -> None:
        """Mark everything currently open as already seen (used at startup)."""
        for item in pending(self.path):
            self._seen.add(item.id)
        self._mtime = self._stamp()

    def _stamp(self) -> float:
        try:
            return self.path.stat().st_mtime
        except OSError:
            return 0.0

    def poll(self) -> list[Item]:
        """New pending items since the last call. Cheap: usually just a stat()."""
        stamp = self._stamp()
        if stamp == self._mtime:
            return []
        self._mtime = stamp
        fresh = [i for i in pending(self.path) if i.id not in self._seen]
        for i in fresh:
            self._seen.add(i.id)
        return fresh
