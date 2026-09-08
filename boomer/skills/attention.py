"""Skill: ending the conversation, in any words and any language.

The window used to close only on a keyword regex -- "that's all", "dismissed",
"we're done". Franko said "now I\'m not gonna speak with you", then "I told you
that I\'m not speaking with you. Stop listening.", then the same in Italian. The
model understood every one and replied "Understood. I will not listen." -- and
kept listening, because understanding was never wired to the state.

So the model gets a tool. Any phrasing works, in any language, because
comprehension is the model\'s job and the regex only ever needed to be a fast
path for the obvious cases.
"""
from __future__ import annotations

from ..tools import Tool, register


def stop_listening(ctx: dict) -> str:
    """Close the conversation window. She will need her name again."""
    close = ctx.get("close_attention")
    if callable(close):
        close()
        return "Closed. She will not act again until her name is said."
    return "I could not close the conversation."


register(
    Tool("stop_listening",
         "Stop listening and end the conversation. Use whenever the user says "
         "they are done talking to you, do not want to talk, want you to stop "
         "listening, or dismisses you -- in ANY wording or language.",
         {}, [], stop_listening,
         lambda **_: "", wants_ctx=True),
)
