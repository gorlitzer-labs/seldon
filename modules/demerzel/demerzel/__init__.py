"""Demerzel -- a fully local voice agent.

Offline mode is set HERE, before anything imports huggingface_hub, because the
loaders otherwise open a connection to huggingface.co on startup to check model
revisions. That never carried audio or transcripts, but "fully local" has to
mean no outbound socket at all, not "no outbound socket that matters".

Verified by: lsof -nP -p <pid> -a -i  showing loopback sockets only.
Weights must already be in the HF cache; scripts/fetch-models.py puts them there.
"""

import os as _os
# Back-compat: this project was renamed Boomer -> Demerzel. Any BOOMER_* var
# still in a shell profile is honoured, mapped to its DEMERZEL_* name unless the
# new one is already set. Runs on package import, before any submodule reads its
# env, so every call site can read only the new names. Remove after migrating.
for _k, _v in list(_os.environ.items()):
    if _k.startswith("BOOMER_"):
        _new = "DEMERZEL_" + _k[len("BOOMER_"):]
        _os.environ.setdefault(_new, _v)
del _os

import os

for _var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
    os.environ.setdefault(_var, "1")
# Telemetry is off by default in recent versions; make it explicit.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
