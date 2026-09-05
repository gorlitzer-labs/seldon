"""Aria AEC spike server.

Serves the test page and receives raw mic PCM over a websocket, bucketed by test
phase. Answers one question: does the browser's echoCancellation actually remove
Aria's own voice from her microphone, and can we get that audio into Python?

Verdict is ERLE (echo return loss enhancement) -- how much quieter the speaker
tone is with AEC on. >20 dB is good, >30 dB is excellent, <10 dB means barge-in
will not work and we need a native CoreAudio path instead.
"""
import asyncio, json, math, struct, threading, http.server, socketserver, functools, os, sys

import websockets

PORT_HTTP, PORT_WS = 8770, 8765
buckets: dict[str, list[float]] = {}
current = {"phase": None}


def rms_dbfs(frame: bytes) -> float:
    n = len(frame) // 4
    if not n:
        return -120.0
    total = 0.0
    for (s,) in struct.iter_unpack("<f", frame):
        total += s * s
    r = math.sqrt(total / n)
    return 20 * math.log10(r) if r > 1e-9 else -180.0


async def handler(ws):
    async for msg in ws:
        if isinstance(msg, str):
            info = json.loads(msg)
            phase = info.get("phase")
            if phase == "done":
                report()
                continue
            current["phase"] = phase
            buckets.setdefault(phase, [])
            print(f"  capturing: {phase}", flush=True)
        else:
            p = current["phase"]
            if p:
                buckets[p].append(rms_dbfs(msg))


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else float("nan")


def report():
    # Drop the first 15 frames of each phase: AEC needs a moment to converge.
    def level(p):
        return median(buckets.get(p, [])[15:])

    floor, off, on = level("noise-floor"), level("tone-aec-off"), level("tone-aec-on")
    print("\n" + "=" * 58)
    print(f"  noise floor            {floor:7.1f} dBFS")
    print(f"  tone, AEC off          {off:7.1f} dBFS")
    print(f"  tone, AEC on           {on:7.1f} dBFS")
    erle = off - on
    print("-" * 58)
    print(f"  ERLE (echo removed)    {erle:7.1f} dB")
    margin = on - floor
    print(f"  residual above floor   {margin:7.1f} dB")
    print("=" * 58)
    if not buckets.get("tone-aec-on"):
        print("  NO AUDIO RECEIVED - the page never sent frames. Spike is broken, not the AEC.")
        sys.stdout.flush()
        return
    if erle >= 20 and margin < 10:
        print("  VERDICT: browser AEC works. Barge-in is viable. Use the page as ears.")
    elif erle >= 10:
        print("  VERDICT: partial. Usable for wake-word gating, risky for barge-in.")
    else:
        print("  VERDICT: browser AEC insufficient -> need a native CoreAudio path.")
    print(f"  frames: " + ", ".join(f"{k}={len(v)}" for k, v in buckets.items()))
    print()
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "result.json"), "w") as fh:
        json.dump({"noise_floor_dbfs": floor, "tone_aec_off_dbfs": off,
                   "tone_aec_on_dbfs": on, "erle_db": erle,
                   "residual_above_floor_db": margin,
                   "frames": {k: len(v) for k, v in buckets.items()}}, fh, indent=2)
    print("  wrote result.json")
    sys.stdout.flush()


def serve_http():
    here = os.path.dirname(os.path.abspath(__file__))
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=here)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT_HTTP), h) as httpd:
        httpd.serve_forever()


async def main():
    threading.Thread(target=serve_http, daemon=True).start()
    print(f"open  http://localhost:{PORT_HTTP}/   (speakers, not headphones)")
    async with websockets.serve(handler, "127.0.0.1", PORT_WS, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
