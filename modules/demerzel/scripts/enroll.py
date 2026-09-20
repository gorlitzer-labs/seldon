#!/usr/bin/env python3
"""Enrol Franko's voice, and report whether the enrolment is actually usable.

Usage:
  scripts/enroll.py recordings/*.wav      # from DEMERZEL_RECORD captures
  scripts/enroll.py --check other.wav     # score a clip against the saved print

The report matters more than the file it writes. If a speaker's own samples do
not agree with each other, no threshold will separate him from anyone else, and
the honest move is to record more or better audio rather than lower the bar.
"""
import sys, warnings
warnings.filterwarnings("ignore")
import soundfile as sf, librosa

sys.path.insert(0, ".")
from demerzel.protocol import MIC_SR
from demerzel.speaker import Speaker, CONVERSE, WRITE


def load(path):
    w, sr = sf.read(path, dtype="float32")
    if w.ndim > 1:
        w = w.mean(axis=1)
    return librosa.resample(w, orig_sr=sr, target_sr=MIC_SR) if sr != MIC_SR else w


args = sys.argv[1:]
if not args:
    print(__doc__)
    sys.exit(2)

spk = Speaker()

if args[0] == "--check":
    if spk.enrolled is None:
        print("nothing enrolled yet")
        sys.exit(1)
    for p in args[1:]:
        sim = spk.similarity(load(p))
        if sim is None:
            print(f"  {p}: too short to score")
            continue
        print(f"  {p}: similarity {sim:.3f}  "
              f"converse={'accept' if sim >= CONVERSE else 'REJECT'}  "
              f"write={'accept' if sim >= WRITE else 'REJECT'}")
    sys.exit(0)

clips = [load(p) for p in args]
print(f"enrolling from {len(clips)} clip(s), "
      f"{sum(len(c) for c in clips) / MIC_SR:.1f}s of audio")
vp, report = spk.enroll(clips)
if vp is None:
    print("FAILED:", report)
    sys.exit(1)
print("  ", report)

lo = report["self_similarity_min"]
if lo < 0.6:
    print(f"\n  WARNING: your own clips agree only {lo:.2f} with each other.")
    print("  Record more, longer, in the room you actually use. Enrolling on")
    print("  this would produce a voiceprint that cannot separate you from anyone.")
elif lo < WRITE:
    print(f"\n  NOTE: self-similarity {lo:.2f} is below the write threshold "
          f"{WRITE}, so some of your own utterances will be refused for writes.")
    print("  That is the safe direction, but more enrolment audio would fix it.")
spk.save(vp, report)
print(f"\nsaved. Score any clip with:  scripts/enroll.py --check <file.wav>")
