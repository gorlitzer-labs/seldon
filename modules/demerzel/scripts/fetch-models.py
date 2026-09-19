#!/usr/bin/env python3
"""Pull Demerzel's model set into the HF cache. Safe to re-run: resumes, skips complete files."""
import os, pathlib, sys, time, urllib.request
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
from huggingface_hub import snapshot_download

MODELS = [
    ("mlx-community/Qwen3.6-35B-A3B-4bit", "LLM  (20.4 GB)"),
    ("mlx-community/Qwen3-ASR-1.7B-8bit",  "STT  (1.9 GB)  default"),
    ("mlx-community/parakeet-tdt-0.6b-v3", "STT  (2.5 GB)  DEMERZEL_STT=parakeet"),
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
# CAM++ speaker verification: a GitHub release asset, not a HF repo.
SPEAKER_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
               "speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx")
dest = pathlib.Path(__file__).resolve().parent.parent / "models" / "campplus_en.onnx"
if dest.exists():
    print(f"\nOK  speaker voiceprint model already present ({dest.stat().st_size/1e6:.0f} MB)", flush=True)
else:
    print(f"\n=== speaker verification (29.6 MB)  CAM++ en_voxceleb ===", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(SPEAKER_URL, dest)
    print(f"OK  -> {dest}", flush=True)

print("\nall models present", flush=True)
