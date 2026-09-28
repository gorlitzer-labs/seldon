#!/usr/bin/env python3
"""Pull Demerzel's model set into the HF cache. Safe to re-run: resumes, skips complete files."""
import os, pathlib, shutil, ssl, sys, time, urllib.request
import certifi
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
from huggingface_hub import snapshot_download

# The LLM repo follows DEMERZEL_LLM so `fetch-models` pulls the model you'll run.
LLM_REPO = os.environ.get("DEMERZEL_LLM", "mlx-community/Qwen3.6-35B-A3B-4bit")
MODELS = [
    (LLM_REPO, f"LLM  ({LLM_REPO})"),
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
    # certifi, not the interpreter's default store: a python.org framework build has
    # no CA bundle until "Install Certificates.command" is run, and every HTTPS
    # request fails CERTIFICATE_VERIFY_FAILED. huggingface_hub already uses certifi,
    # which is why only this download ever broke.
    ctx = ssl.create_default_context(cafile=certifi.where())
    part = dest.with_suffix(".onnx.part")  # never leave a truncated file at `dest`: exists() would bless it
    try:
        with urllib.request.urlopen(SPEAKER_URL, context=ctx, timeout=60) as r, open(part, "wb") as f:
            shutil.copyfileobj(r, f)
        part.replace(dest)
    except Exception as e:
        part.unlink(missing_ok=True)
        print(f"FAIL speaker voiceprint model: {type(e).__name__}: {e}", flush=True)
        sys.exit(1)
    print(f"OK  -> {dest}", flush=True)

print("\nall models present", flush=True)
