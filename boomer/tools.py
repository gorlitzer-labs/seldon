"""The tool mechanism. Capabilities live in boomer/skills/.

Boomer is an everyday assistant, and the factory is one skill inside her rather
than the thing she is. That is Franko's framing and it is the right one: a voice
assistant that can only talk to a build system is a build system with a
microphone.

So this module owns only the machinery -- the Tool shape, the registry, the call
format and execution -- and every capability is a module under skills/ that
registers into it. Adding an MCP client later is another skill, not a rewrite.

Two properties hold across every tool:

WRITES ARE OWNER ONLY, taken from the identified speaker, so a recognised guest
can ask anything and change nothing.

EVERY TOOL DECLARES WHAT IT IS DOING, as a spoken present-tense phrase said
before it runs, with a heartbeat while it runs. Franko asked not to be left in
silence, and `foundation` through npx really does take seconds.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

TIMEOUT_S = 45
HEARTBEAT_S = 30.0       # "keep telling me", not one notice


@dataclass
class Tool:
    name: str
    description: str
    params: dict                 # JSON-schema properties
    required: list[str]
    run: Callable[..., str]
    doing: Callable[..., str]    # what she says before running it
    writes: bool = False
    local: bool = True           # False would mean it leaves the machine
    # Ask before doing it. For anything that starts a process, spends money, or
    # cannot be undone by asking her again.
    confirm: bool = False
    # Receive the turn context, for the few tools that must affect the session
    # itself rather than the world.
    wants_ctx: bool = False

    def schema(self) -> dict:
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": self.params,
                           "required": self.required}}}


TOOLS: dict[str, Tool] = {}


def register(*tools: Tool) -> None:
    for t in tools:
        TOOLS[t.name] = t


def schemas() -> list[dict]:
    return [t.schema() for t in TOOLS.values()]


def load_skills() -> list[str]:
    """Import every skill module so it registers. Import order is irrelevant."""
    from .skills import SKILLS
    return SKILLS


# --- the call format -------------------------------------------------------
# Qwen3.6's template does NOT use JSON here. Its own instruction to the model:
#   <tool_call>
#   <function=name>
#   <parameter=key>
#   value
#   </parameter>
#   </function>
#   </tool_call>
#
# The closing </tool_call> is optional on purpose: models drop it, and a call
# that parsed only when perfectly terminated meant she silently did nothing.
_CALL = re.compile(
    r"<tool_call>\s*<function=([^>\s]+)>(.*?)</function>(?:\s*</tool_call>)?", re.S)
_PARAM = re.compile(r"<parameter=([^>\s]+)>\s*(.*?)\s*</parameter>", re.S)


@dataclass
class Call:
    name: str
    args: dict


def parse_calls(text: str) -> list[Call]:
    out = []
    for m in _CALL.finditer(text or ""):
        out.append(Call(m.group(1).strip(), dict(_PARAM.findall(m.group(2)))))
    return out


def looks_like_call(text: str) -> bool:
    """Cheap check while streaming, so speaking can stop before markup is said."""
    return "<tool_call>" in (text or "")


def render_response(name: str, result: str) -> str:
    return f"<tool_response>\n{result}\n</tool_response>"


def execute(call: Call, may_write: bool, ctx: dict | None = None) -> tuple[str, str]:
    """(spoken_intent, result). Refuses a write for anyone but the owner."""
    tool = TOOLS.get(call.name)
    if tool is None:
        return "", f"I do not have a tool called {call.name}."
    if tool.writes and not may_write:
        return "", "Only Franko can do that, so I did not."
    try:
        intent = tool.doing(**call.args)
    except Exception:
        intent = "Working on it."
    kwargs = {k: v for k, v in call.args.items() if k in tool.params}
    if tool.wants_ctx:
        kwargs["ctx"] = ctx if ctx is not None else {}
    try:
        return intent, tool.run(**kwargs)
    except TypeError as e:
        return intent, f"I called that wrong: {e}."
    except Exception as e:
        return intent, f"That failed: {type(e).__name__}."


def _intent_only(call: Call, may_write: bool) -> str:
    tool = TOOLS.get(call.name)
    if tool is None or (tool.writes and not may_write):
        return ""
    try:
        return tool.doing(**call.args)
    except Exception:
        return "Working on it."


def needs_confirmation(call: Call) -> bool:
    t = TOOLS.get(call.name)
    return bool(t and t.confirm)


def confirmation_question(call: Call) -> str:
    t = TOOLS.get(call.name)
    if t is None:
        return ""
    try:
        return t.doing(**call.args).rstrip(".") + ". Shall I?"
    except Exception:
        return f"Shall I run {call.name}?"


def execute_narrated(call: Call, may_write: bool,
                     narrate: Callable[[str], None],
                     ctx: dict | None = None) -> str:
    """Run a tool, saying what it is before and while it happens."""
    import threading

    intent = _intent_only(call, may_write)
    if intent:
        narrate(intent)

    stop = threading.Event()
    said = {"n": 0}

    def beat():
        while not stop.wait(HEARTBEAT_S):
            said["n"] += 1
            narrate("Still working on that." if said["n"] == 1 else "Still going.")

    threading.Thread(target=beat, daemon=True).start()
    try:
        _, result = execute(call, may_write, ctx)
    finally:
        stop.set()
    return result
