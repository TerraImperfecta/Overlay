#!/usr/bin/env python3
"""Read per-frame timing straight out of an MP4/AVIF or WebM container.

    python3 test/inspect_container.py out/mp4-av1.mp4 out/webm-vp9.webm ...

Written for issue #18. `verifyBlob()` and `ImageDecoder` only prove that some
decoder accepted the file; they say nothing about whether the boxes are
well-formed or whether per-frame timing survived the mux.

Homebrew has dropped Intel x86_64 support, so `ffprobe` cannot be installed on
this machine. That turns out to suit the purpose: a from-specification parser
inspects exactly the structures `PLAN.md` section 4 says to doubt -- `stts`
run-length compression, the single-chunk `stsc`/`stco` arrangement, and WebM
`SimpleBlock` relative timecodes, which are int16 and so force a cluster break
before 32767ms. ffprobe would answer "it parsed"; this answers "here is what
the fields actually say".

Standard library only.
"""

import struct
import sys

# --------------------------------------------------------------------------
# ISOBMFF (MP4, animated AVIF)
# --------------------------------------------------------------------------

CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"meta"}


def walk_boxes(data, start=0, end=None, depth=0):
    """Yield (type, payload_start, payload_end, depth) for every box."""
    end = len(data) if end is None else end
    p = start
    while p + 8 <= end:
        size = struct.unpack(">I", data[p:p + 4])[0]
        typ = data[p + 4:p + 8]
        header = 8
        if size == 1:                                   # 64-bit largesize
            size = struct.unpack(">Q", data[p + 8:p + 16])[0]
            header = 16
        elif size == 0:                                 # extends to end of file
            size = end - p
        if size < header or p + size > end:
            break
        body = p + header
        # `meta` is a FullBox: version+flags precede its children.
        child_start = body + 4 if typ == b"meta" else body
        yield typ, body, p + size, depth
        if typ in CONTAINER_BOXES:
            yield from walk_boxes(data, child_start, p + size, depth + 1)
        p += size


def parse_isobmff(data):
    out = {"brands": None, "timescale": None, "durations": [], "sizes": [],
           "stts_entries": [], "stsc": [], "chunk_offsets": [], "sync": None,
           "has_meta": False, "boxes": []}

    for typ, s, e, depth in walk_boxes(data):
        out["boxes"].append(("  " * depth) + typ.decode("latin-1"))

        if typ == b"ftyp":
            major = data[s:s + 4].decode("latin-1")
            compat = [data[i:i + 4].decode("latin-1") for i in range(s + 8, e, 4)]
            out["brands"] = {"major": major, "compatible": compat}

        elif typ == b"meta":
            out["has_meta"] = True

        elif typ == b"mdhd":
            version = data[s]
            if version == 1:
                out["timescale"] = struct.unpack(">I", data[s + 20:s + 24])[0]
                out["media_duration"] = struct.unpack(">Q", data[s + 24:s + 32])[0]
            else:
                out["timescale"] = struct.unpack(">I", data[s + 12:s + 16])[0]
                out["media_duration"] = struct.unpack(">I", data[s + 16:s + 20])[0]

        elif typ == b"stts":
            n = struct.unpack(">I", data[s + 4:s + 8])[0]
            p = s + 8
            for _ in range(n):
                count, delta = struct.unpack(">II", data[p:p + 8])
                out["stts_entries"].append((count, delta))
                out["durations"].extend([delta] * count)
                p += 8

        elif typ == b"stsz":
            size, count = struct.unpack(">II", data[s + 4:s + 12])
            if size:
                out["sizes"] = [size] * count
            else:
                out["sizes"] = list(struct.unpack(f">{count}I", data[s + 12:s + 12 + 4 * count]))

        elif typ == b"stsc":
            n = struct.unpack(">I", data[s + 4:s + 8])[0]
            p = s + 8
            for _ in range(n):
                out["stsc"].append(struct.unpack(">III", data[p:p + 12]))
                p += 12

        elif typ in (b"stco", b"co64"):
            n = struct.unpack(">I", data[s + 4:s + 8])[0]
            w, f = (8, ">Q") if typ == b"co64" else (4, ">I")
            out["chunk_offsets"] = [
                struct.unpack(f, data[s + 8 + i * w:s + 8 + (i + 1) * w])[0] for i in range(n)
            ]

        elif typ == b"stss":
            n = struct.unpack(">I", data[s + 4:s + 8])[0]
            out["sync"] = list(struct.unpack(f">{n}I", data[s + 8:s + 8 + 4 * n]))

    return out


# --------------------------------------------------------------------------
# EBML (WebM)
# --------------------------------------------------------------------------

def read_vint(data, p, keep_marker=False):
    first = data[p]
    if first == 0:
        raise ValueError("invalid vint")
    length = 1
    mask = 0x80
    while not (first & mask):
        mask >>= 1
        length += 1
    value = first if keep_marker else first & (mask - 1)
    for i in range(1, length):
        value = (value << 8) | data[p + i]
    return value, p + length


def parse_webm(data):
    out = {"timecode_scale": 1000000, "duration": None, "clusters": [],
           "frames": [], "codec": None}
    SEGMENT, INFO, CLUSTER, TRACKS = 0x18538067, 0x1549A966, 0x1F43B675, 0x1654AE6B

    def scan(start, end, path=()):
        p = start
        while p < end:
            try:
                eid, p2 = read_vint(data, p, keep_marker=True)
                size, p3 = read_vint(data, p2)
            except (ValueError, IndexError):
                return
            body_end = end if size == 0x00FFFFFFFFFFFFFF else min(p3 + size, end)

            if eid in (SEGMENT, INFO, CLUSTER, TRACKS) or eid in (0xAE,):   # TrackEntry
                if eid == CLUSTER:
                    out["clusters"].append({"offset": p, "timecode": None, "blocks": 0})
                scan(p3, body_end, path + (eid,))
            elif eid == 0x2AD7B1:                                            # TimecodeScale
                out["timecode_scale"] = int.from_bytes(data[p3:body_end], "big")
            elif eid == 0x4489:                                              # Duration (float)
                raw = data[p3:body_end]
                out["duration"] = struct.unpack(">f" if len(raw) == 4 else ">d", raw)[0]
            elif eid == 0x86:                                                # CodecID
                out["codec"] = data[p3:body_end].decode("latin-1").rstrip("\x00")
            elif eid == 0xE7:                                                # Cluster Timecode
                if out["clusters"]:
                    out["clusters"][-1]["timecode"] = int.from_bytes(data[p3:body_end], "big")
            elif eid in (0xA3, 0xA1):                                        # SimpleBlock / Block
                q = p3
                _track, q = read_vint(data, q)
                rel = struct.unpack(">h", data[q:q + 2])[0]                  # int16, signed
                flags = data[q + 2]
                cluster_tc = out["clusters"][-1]["timecode"] if out["clusters"] else 0
                out["clusters"][-1]["blocks"] += 1
                out["frames"].append({
                    "cluster": len(out["clusters"]) - 1,
                    "relative": rel,
                    "absolute": (cluster_tc or 0) + rel,
                    "keyframe": bool(flags & 0x80),
                })
            p = body_end

    scan(0, len(data))
    return out


# --------------------------------------------------------------------------

def report(path):
    with open(path, "rb") as fh:
        data = fh.read()
    print(f"\n=== {path}  ({len(data)} bytes) ===")

    if data[:4] == b"\x1a\x45\xdf\xa3":
        w = parse_webm(data)
        scale_ms = w["timecode_scale"] / 1e6
        stamps = [f["absolute"] * scale_ms for f in w["frames"]]
        durations = [round(b - a, 3) for a, b in zip(stamps, stamps[1:])]
        print(f"codec           : {w['codec']}")
        print(f"timecode scale  : {w['timecode_scale']} ns  ({scale_ms} ms/tick)")
        print(f"duration        : {w['duration']} ticks"
              f"  = {None if w['duration'] is None else round(w['duration'] * scale_ms, 2)} ms")
        print(f"clusters        : {len(w['clusters'])}"
              f"  {[(c['timecode'], c['blocks']) for c in w['clusters']]}")
        rels = [f["relative"] for f in w["frames"]]
        print(f"frames          : {len(w['frames'])}")
        print(f"relative tcs    : {rels}")
        if rels:
            print(f"max |relative|  : {max(abs(r) for r in rels)}   (int16 limit 32767)")
        print(f"absolute ms     : {[round(s, 2) for s in stamps]}")
        print(f"gaps ms         : {durations}   (last frame's own duration is not stored)")
        print(f"keyframes       : {[i for i, f in enumerate(w['frames']) if f['keyframe']]}")
        return

    m = parse_isobmff(data)
    ts = m["timescale"] or 1
    print(f"brands          : {m['brands']['major']} {m['brands']['compatible']}")
    print(f"meta box        : {'present' if m['has_meta'] else 'absent'}")
    print(f"timescale       : {ts}")
    print(f"media duration  : {m.get('media_duration')} ticks = {m.get('media_duration', 0) * 1000 / ts:.2f} ms")
    print(f"stts entries    : {m['stts_entries']}   (count, delta) -- run-length compressed")
    print(f"frames          : {len(m['durations'])}")
    print(f"durations ms    : {[round(d * 1000 / ts, 3) for d in m['durations']]}")
    print(f"sum ms          : {round(sum(m['durations']) * 1000 / ts, 3)}")
    print(f"sample sizes    : {m['sizes']}")
    print(f"stsc            : {m['stsc']}   (first_chunk, samples_per_chunk, desc)")
    print(f"chunk offsets   : {m['chunk_offsets']}")
    print(f"sync samples    : {m['sync']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    for p in sys.argv[1:]:
        report(p)
