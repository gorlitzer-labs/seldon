"""A Brain that relays to the Ubik pentest agent instead of running an LLM here.

Demerzel becomes the voice; Ubik does the thinking and runs the (scope-gated,
approve-each-command) Kali tools. This is the "talk to Ubik" mode: you speak, Ubik
reasons and proposes a command, Demerzel reads it back and waits for your yes/no.

Same surface as models.Brain (stream / stream_tool_result / reset / warm), so
turn.py is unchanged. Unlike BonsaiBrain there are NO local tools: Ubik owns tool
execution behind its own gate, so this brain never emits tool-call XML — it only
streams what Ubik says. Conversation state lives in Ubik, not here.

Ubik's voice-bridge (ff711 kali-agent/voice_bridge.py) speaks a tiny event
protocol over Server-Sent-Events:
  speak    Ubik's prose                     -> say it
  propose  a command awaiting yes/no        -> say it (it IS the question)
  detail   command / tool / scan output     -> screen only, never spoken
  note     a status line                    -> screen only
One Demerzel turn == one `POST /turn`, which streams until Ubik blocks for the
next input. A leading "scope <target>" is routed to the bridge's /scope instead,
so the operator can authorize a target by voice before scanning it.

Point it with DEMERZEL_UBIK_SERVER (default http://127.0.0.1:8092). Because the
reasoning happens in Ubik's model, no 20 GB LLM loads here — Demerzel keeps only
STT + TTS resident, exactly like the Bonsai path.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Iterator

_SCOPE_RE = re.compile(r"^\s*scope\s+(\S+)\s*$", re.I)


def server_url() -> str:
    return os.environ.get("DEMERZEL_UBIK_SERVER", "http://127.0.0.1:8092").rstrip("/")


def server_healthy(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(server_url() + "/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


class UbikBrain:
    """The LLM as the remote Ubik agent. Same surface as models.Brain."""

    def __init__(self) -> None:
        self.base = server_url()
        self.reset(prewarm=False)

    # --- conversation state (Ubik holds it; nothing to keep here) -----------
    def reset(self, prewarm: bool = True) -> None:
        # No local history and no tools: Ubik is the brain and the tool-runner.
        self.tools: list = []

    def warm(self) -> None:
        server_healthy()

    # --- helpers ------------------------------------------------------------
    def _post(self, path: str, payload: dict, timeout: float = 900):
        req = urllib.request.Request(
            self.base + path, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=timeout)

    def _scope(self, target: str) -> Iterator[str]:
        try:
            with self._post("/scope", {"target": target}, timeout=10) as r:
                json.load(r)
            yield f"Scope set to {target}."
        except Exception as e:
            yield f"Could not set scope: {e}"

    # --- generation ---------------------------------------------------------
    def stream(self, user: str, max_tokens: int = 160) -> Iterator[str]:
        m = _SCOPE_RE.match(user)
        if m:
            yield from self._scope(m.group(1))
            return
        try:
            resp = self._post("/turn", {"text": user})
        except Exception as e:
            yield f"Ubik is unreachable at {self.base}. {e}"
            return
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue                       # skip ": ping" keepalives and blanks
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                # Speak Ubik's prose and its command proposals; everything else
                # (raw scan output, status notes) belongs on screen, not in speech.
                if ev.get("type") in ("speak", "propose") and ev.get("text") or ev.get("command"):
                    yield ev.get("text") or ev.get("command")

    def stream_tool_result(self, wrapped: str, max_tokens: int = 220) -> Iterator[str]:
        # Ubik runs its own tools behind its own gate, so this brain is never
        # asked to continue after a local tool call. Nothing to do.
        return iter(())
