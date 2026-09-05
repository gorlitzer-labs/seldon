#!/usr/bin/env python3
"""Re-check a spike measurement. Usage: check.py <result.json> <key> <min_db>"""
import json, sys, pathlib
f, key, floor = sys.argv[1], sys.argv[2], float(sys.argv[3])
v = json.loads((pathlib.Path(__file__).parent / f).read_text())[key]
print(f"{key} = {v:.1f} dB (need >= {floor})")
sys.exit(0 if v >= floor else 1)
