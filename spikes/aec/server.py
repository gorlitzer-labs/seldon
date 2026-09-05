"""Aria audio spike server -- phase-agnostic.

Serves the spike pages and receives raw mic PCM over a websocket, bucketed by
whatever phase the page declares. Two tests run against it:

  index.html    does the browser cancel Aria's own voice? (ERLE)
  bargein.html  can the mic still hear YOU while she is talking? (speech SNR)

The server does not know the tests; it reports every phase it saw and evaluates
whichever verdict rule matches the phases present.
"""
import asyncio, json, math, struct, threading, http.server, socketserver, functools, os, sys

import websockets

PORT_HTTP, PORT_WS = 8770, 8765
SETTLE = 15  # drop leading frames per phase: AEC/AGC need a moment to converge

buckets: dict[str, list[float]] = {}
current = {"phase": None}
HERE = os.path.dirname(os.path.abspath(__file__))


def rms_dbfs(frame: bytes) -> float:
    n = len(frame) // 4
    if not n:
        return -120.0
    total = 0.0
    for (s,) in struct.iter_unpack("<f", frame):
        total += s * s
    r = math.sqrt(total / n)
    return 20 * math.log10(r) if r > 1e-9 else -180.0


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else float("nan")


def level(phase):
    return median(buckets.get(phase, [])[SETTLE:])


def pct(phase, p):
    """p-th percentile, for separating speech bursts from the gaps between them."""
    xs = sorted(buckets.get(phase, [])[SETTLE:])
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")


def verdict_erle():
    off, on, floor = level("tone-aec-off"), level("tone-aec-on"), level("noise-floor")
    erle, margin = off - on, on - level("noise-floor")
    lines = [f"  ERLE (echo removed)    {erle:7.1f} dB",
             f"  residual above floor   {margin:7.1f} dB"]
    if erle >= 20 and margin < 10:
        v = "browser AEC works. She will not retrigger on her own voice."
    elif erle >= 10:
        v = "partial. Usable for wake-word gating, risky for barge-in."
    else:
        v = "browser AEC insufficient -> need a native CoreAudio path."
    return lines, v, {"erle_db": erle, "residual_above_floor_db": margin,
                      "noise_floor_dbfs": floor}


def verdict_bargein():
    # 90th percentile captures speech peaks; median of tone-only is the residual.
    speech_quiet = pct("speech-only", 0.90)
    residual = level("tone-only")
    speech_over = pct("speech-over-tone", 0.90)
    snr = speech_over - residual
    penalty = speech_quiet - speech_over
    lines = [f"  speech alone (p90)     {speech_quiet:7.1f} dBFS",
             f"  residual echo, no talk {residual:7.1f} dBFS",
             f"  speech over tone (p90) {speech_over:7.1f} dBFS",
             "  " + "-" * 40,
             f"  speech SNR over echo   {snr:7.1f} dB",
             f"  gain penalty on speech {penalty:7.1f} dB"]
    if snr >= 15 and penalty <= 6:
        v = "BARGE-IN WORKS. Your voice rides clearly over her own audio."
    elif snr >= 8:
        v = "marginal. Barge-in will work in a quiet room, not reliably."
    else:
        v = "BARGE-IN FAILS. She cannot hear you while speaking -> push-to-talk or native AEC."
    return lines, v, {"speech_only_p90_dbfs": speech_quiet, "residual_dbfs": residual,
                      "speech_over_tone_p90_dbfs": speech_over,
                      "speech_snr_db": snr, "gain_penalty_db": penalty}


RULES = [({"tone-aec-off", "tone-aec-on"}, "erle", verdict_erle),
         ({"speech-only", "tone-only", "speech-over-tone"}, "bargein", verdict_bargein)]


def report():
    print("\n" + "=" * 58, flush=True)
    for k, v in buckets.items():
        print(f"  {k:22s} {level(k):7.1f} dBFS   ({len(v)} frames)", flush=True)
    print("-" * 58, flush=True)
    have = set(buckets)
    for need, name, fn in RULES:
        if need <= have:
            if any(len(buckets.get(p, [])) <= SETTLE for p in need):
                print("  NO AUDIO - a phase captured nothing. Spike is broken, not the audio.", flush=True)
                return
            lines, v, data = fn()
            for ln in lines:
                print(ln, flush=True)
            print("=" * 58, flush=True)
            print(f"  VERDICT: {v}", flush=True)
            data["frames"] = {k: len(x) for k, x in buckets.items()}
            with open(os.path.join(HERE, f"result-{name}.json"), "w") as fh:
                json.dump(data, fh, indent=2)
            print(f"  wrote result-{name}.json\n", flush=True)
            return
    print("  (no verdict rule matches the phases seen)\n", flush=True)


async def handler(ws):
    async for msg in ws:
        if isinstance(msg, str):
            info = json.loads(msg)
            phase = info.get("phase")
            if phase == "done":
                report()
            elif phase == "reset":
                buckets.clear()
            else:
                current["phase"] = phase
                buckets.setdefault(phase, [])
                print(f"  capturing: {phase}", flush=True)
        elif current["phase"]:
            buckets[current["phase"]].append(rms_dbfs(msg))


def serve_http():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT_HTTP), h) as httpd:
        httpd.serve_forever()


async def main():
    threading.Thread(target=serve_http, daemon=True).start()
    print(f"ERLE test     http://localhost:{PORT_HTTP}/", flush=True)
    print(f"barge-in test http://localhost:{PORT_HTTP}/bargein.html", flush=True)
    async with websockets.serve(handler, "127.0.0.1", PORT_WS, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
