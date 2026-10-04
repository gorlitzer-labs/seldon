"""Who Demerzel works for, as she says it out loud.

Set DEMERZEL_OWNER to your first name and she uses it in her prompt and in her
refusals ("Only Sam can do that"), and listens for it as a hotword. Unset, she
says "the owner". Who may actually change things is decided by the voiceprint
(speaker.py), never by this name.
"""

import os

NAME = os.environ.get("DEMERZEL_OWNER", "").strip()
OWNER = NAME or "the owner"
