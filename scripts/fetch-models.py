#!/usr/bin/env python3
"""Pull Aria's model set into the HF cache. Safe to re-run: resumes, skips complete files."""
import os, sys, time
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
from huggingface_hub import snapshot_download

MODELS = [
    ("mlx-community/Qwen3.6-35B-A3B-4bit", "LLM  (20.4 GB)"),
    ("mlx-community/parakeet-tdt-0.6b-v3", "STT  (2.5 GB)"),
    ("hexgrad/Kokoro-82M",                 "TTS  (0.4 GB)"),
]

for repo, label in MODELS:
    print(f"\n=== {label}  {repo} ===", flush=True)
    t0 = time.time()
    try:
        p = snapshot_download(repo_id=repo, max_workers=8)
        print(f"OK  {repo}  in {time.time()-t0:.0f}s -> {p}", flush=True)
    except Exception as e:
        print(f"FAIL {repo}: {type(e).__name__}: {e}", flush=True)
        sys.exit(1)
print("\nall models present", flush=True)
