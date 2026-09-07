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
import re
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


# --- talking to the factory CLI --------------------------------------------
# Hive state is COMPUTED (parsing the Foundation seam, counting lanes, probing
# reachability), so it is read through `factory state --json` rather than
# reimplemented here -- that is the whole reason gorlitzer-labs/factory#1 exists.
# decisions.json above is different: a plain data file with a documented schema,
# and reading it directly is what makes announcements work with no subprocess in
# the hot path.

import shutil
import subprocess

CLI = os.environ.get("FACTORY_CLI", "factory")
TIMEOUT_S = 10


def cli_available() -> bool:
    return shutil.which(CLI) is not None


def board_state() -> dict | None:
    """`factory state --json`, or None if the factory is not installed here."""
    if not cli_available():
        return None
    try:
        out = subprocess.run([CLI, "state", "--compact"], capture_output=True,
                             text=True, timeout=TIMEOUT_S)
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def board_spoken(state: dict | None) -> str:
    """The board, as one or two sentences a person would actually say."""
    if state is None:
        return "The factory command is not installed on this machine, so I cannot see the board."
    s = state.get("summary", {})
    hives, needs = s.get("hives", 0), s.get("needsYou", 0)
    if not hives and not s.get("pendingDecisions"):
        return "No hives registered yet, and nothing pending."
    def plural(n, word):
        return f"{n} {word}{'' if n == 1 else 's'}"

    parts = []
    if needs == 0:
        parts.append(f"All {plural(hives, 'hive')} nominal. Nothing needs you."
                     if hives else "Nothing needs you.")
    else:
        bits = []
        if s.get("pendingDecisions"):
            bits.append(f"{plural(s['pendingDecisions'], 'decision')} pending")
        if s.get("blockers"):
            bits.append(plural(s["blockers"], "blocker"))
        if s.get("down"):
            bits.append(f"{plural(s['down'], 'hive')} down")
        if s.get("drift"):
            bits.append(f"drift on {s['drift']}")
        # Mentioning the hive count is only useful when there are any.
        lead = f"{plural(hives, 'hive')}. " if hives else ""
        parts.append(lead + ", ".join(bits).capitalize() + ".")
    if s.get("queueOpen"):
        parts.append(f"{s['queueOpen']} items in the queues.")
    return " ".join(parts)


def answer_decision(decision_id: str, answer: str) -> tuple[bool, str]:
    """Run `factory decide`. THIS IS THE ONE WRITE Boomer makes to the factory.

    resolveDecision() in factory only matches status === "pending" and there is
    no un-resolve path, so a misheard answer is filed permanently as the human's
    call and an agent acts on it. Everything upstream of this function exists to
    make sure the user heard their own words read back before it runs.
    """
    if not cli_available():
        return False, "The factory command is not installed here, so I cannot answer that."
    try:
        out = subprocess.run([CLI, "decide", decision_id, answer],
                             capture_output=True, text=True, timeout=TIMEOUT_S)
    except (subprocess.SubprocessError, OSError) as e:
        return False, f"That failed: {type(e).__name__}."
    if out.returncode != 0:
        detail = (out.stderr or out.stdout or "").strip().splitlines()
        return False, "That failed. " + (detail[0][:120] if detail else "")
    return True, f"Answered. {answer}."


# --- intent + confirmation --------------------------------------------------

_BOARD = re.compile(
    r"\b((what|how)('s|s| is| are)? ?(on )?the board|board status|"
    r"status of the (hives|factory|board)|anything need(s|ing)? me|what needs me|"
    r"how('s| is)? the factory|what'?s? (up|going on)|give me the board)\b", re.I)
_ANSWER = re.compile(r"\b(answer|tell (her|him|them)|reply|go with|say)\b\s+(?P<a>.+)", re.I)
_YES = re.compile(r"^\s*(yes|yeah|yep|correct|confirm(ed)?|do it|go ahead|that'?s right)\b", re.I)
_NO = re.compile(r"^\s*(no|nope|cancel|stop|forget it|don'?t|wrong)\b", re.I)


def is_board_query(utterance: str) -> bool:
    return bool(_BOARD.search(utterance or ""))


def is_affirmative(utterance: str) -> bool:
    return bool(_YES.search(utterance or ""))


def is_negative(utterance: str) -> bool:
    return bool(_NO.search(utterance or ""))


def detect_answer(utterance: str) -> str | None:
    """Extract an intended answer to a pending decision, if the phrasing is explicit.

    Deliberately requires a verb ("answer X", "go with X"). Treating any bare
    reply as an answer would let ordinary conversation resolve a decision by
    accident, which is unrecoverable.
    """
    m = _ANSWER.search(utterance or "")
    if not m:
        return None
    a = " ".join(m.group("a").split()).strip(" .,:;")
    # Trailing filler is not part of the answer: "go with Postgres instead"
    # should file "Postgres", not "Postgres instead". Kept to words that never
    # carry meaning here -- "for now" and "temporarily" genuinely do.
    a = re.sub(r"\b(instead|then|please|thanks|thank you|ok(ay)?)\s*$", "", a, flags=re.I)
    return a.strip(" .,:;")[:200] or None
