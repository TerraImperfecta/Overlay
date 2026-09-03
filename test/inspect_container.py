#!/usr/bin/env python3
"""Read per-frame timing straight out of an MP4/AVIF or WebM container.

    python3 test/inspect_container.py out/mp4-av1.mp4 out/webm-vp9.webm ...
    python3 test/inspect_container.py --meta out/avif.avif

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

`--meta` pulls apart an AVIF's still-image fallback -- `pitm`, `iinf`, `iloc`,
`iprp` -- and checks the claim in issue #20 that the primary still item's `iloc`
extent points at the same bytes as sample zero in `mdat`. That is checkable
rather than merely observable, which is the point.

Standard library only.
"""

import struct
import sys

# --------------------------------------------------------------------------
# ISOBMFF (MP4, animated AVIF)
# --------------------------------------------------------------------------

CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"meta",
                   b"iprp", b"ipco", b"iinf"}


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
        # FullBox containers put version+flags (and sometimes a count) before
        # their children; stepping over them is what makes iinf/ipco visible.
        child_start = body
        if typ == b"meta":
            child_start = body + 4
        elif typ == b"iinf":
            child_start = body + 4 + (4 if data[body] else 2)
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


# --------------------------------------------------------------------------
# The AVIF `meta` box: the still-image fallback (issue #20)
# --------------------------------------------------------------------------

def parse_meta(data):
    """Pull apart pitm / iinf / iloc / iprp so the still item can be checked.

    The claim under test is that the primary still item's `iloc` extent points
    at the same bytes as sample zero in `mdat`. That is checkable rather than
    merely observable, which is the whole reason this exists.
    """
    out = {"pitm": None, "items": {}, "iloc": {}, "ipco": [], "ipma": {}}

    for typ, s, e, _d in walk_boxes(data):
        if typ == b"pitm":
            v = data[s]
            out["pitm"] = (struct.unpack(">I", data[s + 4:s + 8])[0] if v
                           else struct.unpack(">H", data[s + 4:s + 6])[0])

        elif typ == b"infe":
            v = data[s]
            if v >= 2:
                iid = (struct.unpack(">I", data[s + 4:s + 8])[0] if v == 3
                       else struct.unpack(">H", data[s + 4:s + 6])[0])
                off = s + (8 if v == 3 else 6)
                off += 2                                   # protection_index
                out["items"][iid] = data[off:off + 4].decode("latin-1")

        elif typ == b"iloc":
            v, p = data[s], s + 4
            sizes = data[p]; p += 1
            offset_size, length_size = sizes >> 4, sizes & 15
            sizes2 = data[p]; p += 1
            base_offset_size, index_size = sizes2 >> 4, sizes2 & 15
            if v < 2:
                count = struct.unpack(">H", data[p:p + 2])[0]; p += 2
            else:
                count = struct.unpack(">I", data[p:p + 4])[0]; p += 4
            out["iloc"]["field_sizes"] = {
                "offset": offset_size, "length": length_size,
                "base_offset": base_offset_size, "index": index_size}
            out["iloc"]["version"] = v
            out["iloc"]["items"] = []
            rd = lambda q, n: (int.from_bytes(data[q:q + n], "big") if n else 0, q + n)
            for _ in range(count):
                if v < 2:
                    iid = struct.unpack(">H", data[p:p + 2])[0]; p += 2
                else:
                    iid = struct.unpack(">I", data[p:p + 4])[0]; p += 4
                method = None
                if v in (1, 2):
                    method = struct.unpack(">H", data[p:p + 2])[0] & 15; p += 2
                p += 2                                     # data_reference_index
                base, p = rd(p, base_offset_size)
                n_ext = struct.unpack(">H", data[p:p + 2])[0]; p += 2
                extents = []
                for _ in range(n_ext):
                    if v in (1, 2) and index_size:
                        _idx, p = rd(p, index_size)
                    off, p = rd(p, offset_size)
                    ln, p = rd(p, length_size)
                    extents.append({"offset": base + off, "length": ln})
                out["iloc"]["items"].append(
                    {"item": iid, "construction_method": method, "extents": extents})

        elif typ == b"ipco":
            for t2, s2, e2, _ in walk_boxes(data, s, e):
                out["ipco"].append({"index": len(out["ipco"]) + 1,
                                    "type": t2.decode("latin-1"), "bytes": e2 - s2})

        elif typ == b"ipma":
            v, flags = data[s], int.from_bytes(data[s + 1:s + 4], "big")
            p = s + 4
            n = struct.unpack(">I", data[p:p + 4])[0]; p += 4
            for _ in range(n):
                if v < 1:
                    iid = struct.unpack(">H", data[p:p + 2])[0]; p += 2
                else:
                    iid = struct.unpack(">I", data[p:p + 4])[0]; p += 4
                cnt = data[p]; p += 1
                assoc = []
                for _ in range(cnt):
                    if flags & 1:
                        raw = struct.unpack(">H", data[p:p + 2])[0]; p += 2
                        assoc.append({"essential": bool(raw & 0x8000), "property": raw & 0x7FFF})
                    else:
                        raw = data[p]; p += 1
                        assoc.append({"essential": bool(raw & 0x80), "property": raw & 0x7F})
                out["ipma"][iid] = assoc
    return out


def report_meta(path):
    with open(path, "rb") as fh:
        data = fh.read()
    m = parse_isobmff(data)
    meta = parse_meta(data)
    print(f"\n=== {path}: meta box ===")
    if not m["has_meta"]:
        print("no meta box -- no still-image fallback in this file")
        return
    print(f"brands          : {m['brands']['major']} {m['brands']['compatible']}")
    print(f"primary item    : {meta['pitm']}")
    print(f"items           : {meta['items']}")
    print(f"iloc version    : {meta['iloc'].get('version')}  field sizes {meta['iloc'].get('field_sizes')}")
    for it in meta["iloc"].get("items", []):
        print(f"  item {it['item']}: construction_method={it['construction_method']} extents={it['extents']}")
    print(f"ipco properties : {[(p['index'], p['type']) for p in meta['ipco']]}")
    print(f"ipma            : {meta['ipma']}")

    # The claim: the still item aliases sample zero.
    if m["chunk_offsets"] and m["sizes"] and meta["iloc"].get("items"):
        s0_off, s0_len = m["chunk_offsets"][0], m["sizes"][0]
        ext = meta["iloc"]["items"][0]["extents"][0]
        ok = (ext["offset"] == s0_off and ext["length"] == s0_len)
        print(f"\nsample 0 in mdat: offset={s0_off} length={s0_len}")
        print(f"still item extent: offset={ext['offset']} length={ext['length']}")
        print(f"aliases sample 0 : {'YES' if ok else 'NO -- MISMATCH'}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    args = [a for a in sys.argv[1:] if a != "--meta"]
    for p in args:
        if "--meta" in sys.argv:
            report_meta(p)
        else:
            report(p)
