#!/usr/bin/env python3
"""Re-check a recorded measurement, so a fact stays falsifiable.

Usage: check-metric.py <json-path> <dotted.key> <bound> [min|max]
Exits 0 only if the measured value still satisfies the bound.
"""
import json, sys, pathlib
path, key, bound = sys.argv[1], sys.argv[2], float(sys.argv[3])
mode = sys.argv[4] if len(sys.argv) > 4 else "min"
v = json.loads(pathlib.Path(path).read_text())
for part in key.split("."):
    v = v[part]
ok = v >= bound if mode == "min" else v <= bound
print(f"{key} = {v:.1f} (need {mode} {bound})")
sys.exit(0 if ok else 1)
