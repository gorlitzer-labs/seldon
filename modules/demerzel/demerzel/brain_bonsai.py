"""A Brain backed by a local OpenAI-compatible server (llama.cpp / Bonsai 2),
instead of an in-process MLX model.

Why a server: Bonsai 2's ternary GGUF needs PrismML's llama.cpp kernels and can
only run through their llama-server; and running it in-process would collide with
demerzel's stock-MLX speech stack. As a separate process it also frees the ~20 GB
the in-process Qwen brain holds -- the voice keeps only STT + TTS resident.

Drop-in for models.Brain: same stream / stream_tool_result / reset / warm surface,
so turn.py and its tool loop are unchanged. The server (started with --jinja)
returns native OpenAI tool_calls; we re-serialise them into the <tool_call>
<function=..><parameter=..> form tools.parse_calls already expects, so the parser
does not change either. Conversation state is a message list here, not a KV cache.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Iterator


def _system() -> str:
    from .identity import as_prompt as identity
    from .memory import as_prompt
    from .models import SYSTEM
    return SYSTEM + identity() + as_prompt()


def _tools() -> list:
    from .tools import load_skills, schemas
    load_skills()          # importing a skill module registers its tools
    return schemas()


def server_url() -> str:
    return os.environ.get("DEMERZEL_LLM_SERVER", "http://127.0.0.1:8081").rstrip("/")


def server_healthy(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(server_url() + "/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


class BonsaiBrain:
    """The LLM as a local OpenAI-compatible server. Same surface as models.Brain."""

    def __init__(self) -> None:
        self.url = server_url() + "/v1/chat/completions"
        self.reset(prewarm=False)

    # --- conversation state -------------------------------------------------
    def reset(self, prewarm: bool = True) -> None:
        # The system block (with tools) rides in the message list; the server
        # re-renders it each call. No KV cache to prewarm, so prewarm is a no-op.
        self.messages: list[dict] = [{"role": "system", "content": _system()}]
        self.tools = _tools()
        self._pending_ids: list[str] = []
        self._turns = 0

    def warm(self) -> None:
        # The server is already resident; exercise the path once, cheaply.
        try:
            for _ in self.stream("hi", max_tokens=1):
                pass
        except Exception:
            pass
        self.reset()

    # --- generation ---------------------------------------------------------
    def _post(self, max_tokens: int):
        body = {
            "messages": self.messages,
            "tools": self.tools,
            "stream": True,
            "temperature": 0.7,
            "top_p": 0.9,
            "max_tokens": max_tokens,
            # Bonsai/Qwen are reasoning models; demerzel is a low-latency voice,
            # so thinking is off (matches the in-process Brain's enable_thinking=False).
            # Otherwise a <think> block eats the token budget before any speech.
            "chat_template_kwargs": {"enable_thinking": False},
        }
        req = urllib.request.Request(
            self.url, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=120)

    def _stream(self, max_tokens: int) -> Iterator[str]:
        """Stream content deltas; collect tool_calls; then yield them as the XML
        tools.parse_calls understands. Records the assistant turn in history."""
        content = ""
        tcs: dict[int, dict] = {}
        with self._post(max_tokens) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    d = json.loads(data)
                except Exception:
                    continue
                choice = (d.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    content += delta["content"]
                    yield delta["content"]
                for tc in delta.get("tool_calls") or []:
                    i = tc.get("index", 0)
                    e = tcs.setdefault(i, {"id": "", "name": "", "args": ""})
                    if tc.get("id"):
                        e["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        e["name"] = fn["name"]
                    if fn.get("arguments"):
                        e["args"] += fn["arguments"]

        # record the assistant turn so the next call has context
        asst: dict = {"role": "assistant", "content": content or ""}
        if tcs:
            asst["tool_calls"] = [
                {"id": e["id"], "type": "function",
                 "function": {"name": e["name"], "arguments": e["args"]}}
                for e in tcs.values()]
            self._pending_ids = [e["id"] for e in tcs.values()]
        self.messages.append(asst)

        # re-serialise tool calls into demerzel's native XML for parse_calls
        for e in tcs.values():
            try:
                args = json.loads(e["args"] or "{}")
            except Exception:
                args = {}
            params = "".join(
                f"<parameter={k}>\n{v}\n</parameter>\n" for k, v in args.items())
            yield f"<tool_call>\n<function={e['name']}>\n{params}</function>\n</tool_call>"

    def stream(self, user: str, max_tokens: int = 160) -> Iterator[str]:
        self.messages.append({"role": "user", "content": user})
        self._turns += 1
        yield from self._stream(max_tokens)

    def stream_tool_result(self, wrapped: str, max_tokens: int = 220) -> Iterator[str]:
        # turn.py hands us "<tool_response>\n{result}\n</tool_response>"; the
        # server wants a role:tool message tied to the call it answers.
        m = re.search(r"<tool_response>\s*(.*?)\s*</tool_response>", wrapped, re.S)
        result = m.group(1) if m else wrapped
        msg: dict = {"role": "tool", "content": result}
        if self._pending_ids:
            msg["tool_call_id"] = self._pending_ids.pop(0)
        self.messages.append(msg)
        yield from self._stream(max_tokens)
