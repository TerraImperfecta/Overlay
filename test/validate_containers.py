#!/usr/bin/env python3
"""Read the exported MP4s and WebMs with FFmpeg's own demuxer (#58).

test/inspect_container.py parses these files from the specification, which makes
it a *second implementation* rather than an independent authority: a shared
misreading of the spec would fool it and the muxer alike, and neither would
notice. GIF, WebP, APNG and AVIF have real outside witnesses -- gifsicle,
webpinfo, pngcheck, avifdec -- and ISOBMFF is corroborated indirectly, because
animated AVIF shares muxISOBMFF with MP4. EBML had nothing but our own parser
and Chrome agreeing to play the file.

This closes that gap with libavformat, which is what ffprobe is a thin CLI over.
PyAV ships it in its wheels, so no system package is needed:

    python3 -m venv .venv && .venv/bin/pip install av
    npm run fixtures
    .venv/bin/python test/validate_containers.py

Packets, not decoded frames: the question is what the container says, and a
decoder would answer with what the codec reconstructed from it.
"""

import json
import pathlib
import sys

try:
    import av
except ImportError:
    sys.exit("PyAV is not installed. See the header of this file.")

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out")
TOLERANCE_MS = 1.0          # containers store integer ticks; MP4 rounds


def timestamps_ms(path):
    """Every video packet's presentation time, in milliseconds."""
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        tb = stream.time_base
        pts = [float(p.pts * tb) * 1000 for p in container.demux(stream)
               if p.pts is not None and p.size]
        return pts, str(stream.codec_context.name), container.format.name


def check(record, label):
    """Validate one run's files against the plan it was exported from."""
    plan = record["plan"]
    want, count = plan["times"], plan["count"]
    # Only what this run wrote: out/ keeps the other run's files alongside, and
    # they belong to a different plan entirely.
    mine = {e["file"] for e in record["written"] if e["ext"] in ("mp4", "webm")}

    span = f"{want[0]}..{want[-1]}" if len(want) > 8 else str(want)
    print(f"\n{label}: {count} frames at {span} ms")
    print(f"{'file':<22}{'format':<10}{'codec':<10}{'frames':<8}{'worst drift':<13}verdict")

    bad = 0
    files = sorted(OUT / f for f in mine)
    if not files:
        print("  (no MP4 or WebM recorded)")
        return 0
    for entry in files:
        try:
            got, codec, fmt = timestamps_ms(entry)
        except Exception as exc:                       # noqa: BLE001
            print(f"{entry.name:<22}{'-':<10}{'-':<10}{'-':<8}{'-':<13}UNREADABLE: {exc}")
            bad += 1
            continue

        ok = len(got) == count
        drift = max((abs(g - w) for g, w in zip(got, want)), default=float("inf"))
        ok = ok and drift <= TOLERANCE_MS
        bad += not ok
        print(f"{entry.name:<22}{fmt.split(",")[0]:<10}{codec:<10}{len(got):<8}"
              f"{drift:<13.3f}{'ok' if ok else 'MISMATCH'}")
        if not ok:
            print(f"    wanted {want}")
            print(f"    got    {[round(g, 1) for g in got]}")
    return bad


def main():
    print(f"libavformat {'.'.join(map(str, av.library_versions['libavformat']))}"
          f"  (PyAV {av.__version__})")

    runs = [("plan.json", "normal"), ("plan-long.json", "stress")]
    seen, bad = 0, 0
    for name, label in runs:
        f = OUT / name
        if not f.exists():
            continue
        seen += 1
        bad += check(json.loads(f.read_text()), label)

    if not seen:
        sys.exit(f"no plan file in {OUT}/; run `npm run fixtures` first.")
    print()
    print("every timestamp agrees with its plan" if not bad
          else f"{bad} file(s) disagree")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
