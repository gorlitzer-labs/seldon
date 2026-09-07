"""What Boomer remembers between conversations.

Today her only memory is a KV cache that dies with the process. Ask her to
remember something and it is gone on restart, which is the gap between a voice
demo and an assistant.

Design choices worth stating, because the obvious answers are wrong here:

* EXPLICIT, not inferred. "Remember that X" writes; ordinary chat does not. A
  model deciding for itself what was worth keeping produces a store full of
  confident junk, and you cannot audit what you never saw it decide.

* SYSTEM PROMPT, not retrieval. A few dozen personal facts belong in the prompt,
  not a vector index. They are prefilled into the KV cache once at boot, so they
  cost no per-turn latency at all -- the same prefill already measured. RAG only
  earns its complexity when the store outgrows the context, and this one will
  not for a long time.

* CONFIRMED BEFORE WRITING. The input is speech-to-text, which was measured
  turning "Postgres" into "poskers". Writing an unverified transcript into
  durable memory means quietly remembering something the user never said, so
  every write is read back first.

* PLAIN MARKDOWN. Readable and correctable in an editor. If Boomer's memory is
  wrong the fix should be one line in a text file, not a database migration.
"""
from __future__ import annotations

import datetime as _dt
import os
import pathlib
import re
from dataclasses import dataclass

STORE = pathlib.Path(os.environ.get(
    "BOOMER_MEMORY", pathlib.Path.home() / ".boomer" / "memory.md"))

MAX_ITEMS = 200          # a guardrail, not a target
MAX_LEN = 300            # one remembered thing is a sentence, not an essay

_LINE = re.compile(r"^- \[(?P<when>\d{4}-\d{2}-\d{2})\] (?P<text>.+)$")


@dataclass(frozen=True)
class Memory:
    when: str
    text: str

    def line(self) -> str:
        return f"- [{self.when}] {self.text}"


def _today() -> str:
    return _dt.date.today().isoformat()


def load() -> list[Memory]:
    """Every remembered item. A missing store is normal."""
    try:
        raw = STORE.read_text()
    except (FileNotFoundError, OSError):
        return []
    out = []
    for ln in raw.splitlines():
        m = _LINE.match(ln.strip())
        if m:
            out.append(Memory(m.group("when"), m.group("text").strip()))
    return out


def normalise(text: str) -> str:
    """Trim to one clean line: drop the vocative, the verb, and the leading 'that'.

    "Boomer, make a note that standup is at nine thirty"  ->
    "standup is at nine thirty"
    """
    text = " ".join((text or "").split())
    # a vocative at the front ("Boomer," / "hey Boomer")
    text = re.sub(r"^(hey\s+|ok(ay)?\s+)?boomer\b[,:]?\s*", "", text, flags=re.I)
    text = re.sub(r"^(please\s+)?(remember|make a note|note|keep in mind)\b", "", text, flags=re.I)
    # the conjunction left behind by either the verb or detect()
    text = re.sub(r"^\s*(that|this|about)\b[,:]?\s*", "", text, flags=re.I)
    text = " ".join(text.split()).strip(" .,:;-")
    return text[:MAX_LEN]


def remember(text: str) -> Memory | None:
    """Append one item. Returns None if empty or already known."""
    text = normalise(text)
    if not text:
        return None
    existing = load()
    if any(m.text.lower() == text.lower() for m in existing):
        return None                                   # never duplicate
    if len(existing) >= MAX_ITEMS:
        return None
    item = Memory(_today(), text)
    STORE.parent.mkdir(parents=True, exist_ok=True)
    with STORE.open("a") as fh:                       # append-only: O_APPEND, lock-free
        if not STORE.stat().st_size:
            fh.write("# Boomer's memory\n\nOne line per remembered item. "
                     "Safe to edit or delete by hand.\n\n")
        fh.write(item.line() + "\n")
    return item


# Filler that carries no meaning in "forget the thing about X".
_FILLER = {"thing", "things", "about", "that", "this", "the", "a", "an", "my",
           "your", "note", "notes", "memory", "memories", "item", "stuff", "of",
           "for", "with", "on", "in", "it", "one"}


def _content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower())
            if len(w) > 2 and w not in _FILLER}


def forget(fragment: str) -> list[Memory]:
    """Drop every item mentioning any content word of the fragment.

    Literal substring matching fails the way people actually speak: "forget the
    thing about SQLite" would search for "thing about sqlite" and find nothing.
    Matching on content words finds it. Deliberately generous, because the
    caller reads back exactly what was dropped and the store is a text file the
    user can edit -- an over-eager delete is visible and recoverable, whereas a
    forget that silently does nothing is not.
    """
    words = _content_words(normalise(fragment))
    if not words:
        return []
    items = load()
    hit = lambda m: bool(words & _content_words(m.text))
    keep = [m for m in items if not hit(m)]
    dropped = [m for m in items if hit(m)]
    if dropped:
        header = ("# Boomer's memory\n\nOne line per remembered item. "
                  "Safe to edit or delete by hand.\n\n")
        STORE.write_text(header + "".join(m.line() + "\n" for m in keep))
    return dropped


def as_prompt() -> str:
    """The block injected into the system prompt at boot. Empty if nothing known."""
    items = load()
    if not items:
        return ""
    lines = "\n".join(f"- {m.text}" for m in items[-MAX_ITEMS:])
    return ("\n\nThings you have been asked to remember about Franko. Treat them as "
            "true and use them without being asked:\n" + lines)


# --- intent detection -------------------------------------------------------
# Deliberately keyword-based, not model-based: a write to durable storage should
# be triggered by something auditable, not by a model's mood.

_REMEMBER = re.compile(
    r"\b(remember|make a note|note that|keep in mind|don'?t forget)\b", re.I)
_FORGET = re.compile(r"\b(forget|delete|remove)\b.{0,20}\b(that|about|note|memory)\b", re.I)
_RECALL = re.compile(
    r"\b(what do you (know|remember)|what have you remembered|list (your )?memor)", re.I)


def detect(utterance: str) -> tuple[str, str]:
    """Classify an utterance as ('remember'|'forget'|'recall'|'none', payload)."""
    u = (utterance or "").strip()
    if not u:
        return "none", ""
    if _RECALL.search(u):
        return "recall", ""
    if _FORGET.search(u):
        return "forget", re.sub(r".*?\b(forget|delete|remove)\b", "", u, count=1, flags=re.I)
    if _REMEMBER.search(u):
        return "remember", _REMEMBER.sub("", u, count=1)
    return "none", ""
