#!/usr/bin/env python3
"""Exit 0 only if the measured browser AEC still clears the 20 dB bar."""
import json, sys, pathlib
r = json.loads((pathlib.Path(__file__).parent / "result.json").read_text())
erle = r["erle_db"]
print(f"ERLE {erle:.1f} dB")
sys.exit(0 if erle >= 20 else 1)
