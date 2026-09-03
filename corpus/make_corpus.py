#!/usr/bin/env python3
"""Generate the GIF decoder regression corpus.

Standard library only, to match the repository's no-dependency rule. The files
are written byte by byte rather than through an imaging library because the
cases that matter here -- the interlace flag, disposal method 3, per-frame local
colour tables, sub-rectangle placement -- are exactly the fields a library
chooses for you.

Run from the repository root:

    python3 corpus/make_corpus.py

It writes corpus/*.gif plus corpus/expected.json, which records, for every file,
the frame count, the per-frame delay in milliseconds after the decoder's
sub-20ms clamp, and a set of pixel probes. The probes come from the drawing
plan below -- what each frame is *meant* to look like -- not from decoding the
output, so they are an independent statement of intent rather than a restatement
of whatever the encoder happened to produce.
"""

import json
import os

# --------------------------------------------------------------------------
# LZW
# --------------------------------------------------------------------------


class BitWriter:
    """GIF packs LZW codes least-significant-bit first."""

    def __init__(self):
        self.out = bytearray()
        self.cur = 0
        self.nbits = 0

    def write(self, code, width):
        self.cur |= code << self.nbits
        self.nbits += width
        while self.nbits >= 8:
            self.out.append(self.cur & 0xFF)
            self.cur >>= 8
            self.nbits -= 8

    def flush(self):
        if self.nbits:
            self.out.append(self.cur & 0xFF)
            self.cur = 0
            self.nbits = 0
        return bytes(self.out)


def lzw_encode(indices, min_code_size):
    """Compress index bytes to a GIF LZW stream.

    The code-size increase is the subtle part. A decoder adds a table entry for
    every code it reads *except* the first one after a clear, so its table is
    permanently one entry behind the encoder's. It widens when its own counter
    reaches 1 << code_size; for the encoder that moment is one entry later,
    hence `>` rather than `==`. Get this wrong and the stream decodes as noise
    only for images large enough to reach the first bump, which is precisely
    the kind of bug a small test corpus fails to catch.
    """
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    table = {bytes([i]): i for i in range(clear)}
    next_code = eoi + 1

    bw = BitWriter()
    bw.write(clear, code_size)

    if not indices:
        bw.write(eoi, code_size)
        return bw.flush()

    w = bytes([indices[0]])
    for k in indices[1:]:
        wk = w + bytes([k])
        if wk in table:
            w = wk
            continue
        bw.write(table[w], code_size)
        if next_code < 4096:
            table[wk] = next_code
            next_code += 1
            if next_code > (1 << code_size) and code_size < 12:
                code_size += 1
        else:
            bw.write(clear, code_size)
            table = {bytes([i]): i for i in range(clear)}
            next_code = eoi + 1
            code_size = min_code_size + 1
        w = bytes([k])

    bw.write(table[w], code_size)
    bw.write(eoi, code_size)
    return bw.flush()


def sub_blocks(data):
    """GIF carries LZW output in length-prefixed chunks of at most 255 bytes."""
    out = bytearray()
    for i in range(0, len(data), 255):
        chunk = data[i:i + 255]
        out.append(len(chunk))
        out += chunk
    out.append(0)
    return bytes(out)


# --------------------------------------------------------------------------
# GIF structure
# --------------------------------------------------------------------------


def pad_palette(colors):
    """A colour table must hold a power-of-two number of entries, 2 to 256."""
    n = 2
    while n < len(colors):
        n *= 2
    padded = list(colors) + [(0, 0, 0)] * (n - len(colors))
    bits = n.bit_length() - 2          # stored as `2 << bits` entries
    raw = bytearray()
    for r, g, b in padded:
        raw += bytes((r, g, b))
    return bytes(raw), bits, n


def u16(v):
    return bytes((v & 0xFF, (v >> 8) & 0xFF))


def header(width, height, gct_bits, background=0):
    return b"GIF89a" + u16(width) + u16(height) + bytes((0x80 | (gct_bits & 7), background, 0))


def netscape_loop():
    """Loop forever. The decoder must skip this application extension cleanly."""
    return b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"


def gce(delay_cs, disposal, transparent=None):
    packed = (disposal & 7) << 2
    if transparent is not None:
        packed |= 1
    return (b"\x21\xF9\x04" + bytes((packed,)) + u16(delay_cs)
            + bytes((transparent if transparent is not None else 0, 0)))


def image_block(x, y, w, h, indices, min_code_size, interlaced=False, lct=None):
    packed = 0
    body = b""
    if lct is not None:
        raw, bits, _ = pad_palette(lct)
        packed |= 0x80 | (bits & 7)
        body = raw
    if interlaced:
        packed |= 0x40
    return (b"\x2C" + u16(x) + u16(y) + u16(w) + u16(h) + bytes((packed,)) + body
            + bytes((min_code_size,)) + sub_blocks(lzw_encode(indices, min_code_size)))


def interlace_rows(rows):
    """Reorder rows into GIF's four interlace passes.

    Pass 1 takes every 8th row from 0, pass 2 every 8th from 4, pass 3 every 4th
    from 2, pass 4 every 2nd from 1. A decoder that gets this wrong produces a
    plausible-looking but scrambled image, which is why the fixture uses a
    monotonic grey ramp: any error shows up as a non-monotonic column.
    """
    h = len(rows)
    out = []
    for start, step in ((0, 8), (4, 8), (2, 4), (1, 2)):
        for y in range(start, h, step):
            out.append(rows[y])
    return out


# --------------------------------------------------------------------------
# Intent model: what each frame is meant to look like once composited
# --------------------------------------------------------------------------


class Canvas:
    """A minimal GIF compositor, written from the spec.

    This exists to produce expectations, not to check the encoder against
    itself: every draw call below mirrors a deliberate authoring decision, so
    the probes it yields say what the frame *should* contain.
    """

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [(0, 0, 0, 0)] * (w * h)

    def copy(self):
        c = Canvas(self.w, self.h)
        c.px = list(self.px)
        return c

    def draw(self, x, y, w, h, indices, palette, transparent=None):
        for yy in range(h):
            gy = y + yy
            if not (0 <= gy < self.h):
                continue
            for xx in range(w):
                gx = x + xx
                if not (0 <= gx < self.w):
                    continue
                idx = indices[yy * w + xx]
                if transparent is not None and idx == transparent:
                    continue
                r, g, b = palette[idx]
                self.px[gy * self.w + gx] = (r, g, b, 255)

    def clear_rect(self, x, y, w, h):
        for yy in range(h):
            gy = y + yy
            if not (0 <= gy < self.h):
                continue
            for xx in range(w):
                gx = x + xx
                if 0 <= gx < self.w:
                    self.px[gy * self.w + gx] = (0, 0, 0, 0)

    def at(self, x, y):
        return list(self.px[y * self.w + x])


def real_delay_ms(cs):
    """The decoder's clamp: browsers render 0 and 1 centisecond as ~100ms."""
    ms = cs * 10
    return 100 if ms < 20 else ms


# --------------------------------------------------------------------------
# Palettes
# --------------------------------------------------------------------------

GREY16 = [(i * 17, i * 17, i * 17) for i in range(16)]

BLACK, RED, GREEN, BLUE = (0, 0, 0), (255, 0, 0), (0, 255, 0), (0, 0, 255)
YELLOW, MAGENTA, CYAN, WHITE = (255, 255, 0), (255, 0, 255), (0, 255, 255), (255, 255, 255)
P8 = [BLACK, RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN, WHITE]


def solid(w, h, idx):
    return bytes([idx]) * (w * h)


# --------------------------------------------------------------------------
# The corpus
# --------------------------------------------------------------------------

CORPUS = []


def emit(name, note, width, height, palette, frames, probes_per_frame=None):
    """Assemble one GIF and record what it should decode to.

    `frames` is a list of dicts: x, y, w, h, indices, delay_cs, disposal,
    optional interlaced / lct / transparent / no_gce.
    """
    gct_raw, gct_bits, _ = pad_palette(palette)
    mcs = max(2, (len(palette) - 1).bit_length())

    data = bytearray(header(width, height, gct_bits))
    data += gct_raw
    if len(frames) > 1:
        data += netscape_loop()

    canvas = Canvas(width, height)
    saved = None
    expected_frames = []

    for f in frames:
        if not f.get("no_gce"):
            data += gce(f["delay_cs"], f["disposal"], f.get("transparent"))
        indices = f["indices"]
        payload = indices
        if f.get("interlaced"):
            rows = [indices[r * f["w"]:(r + 1) * f["w"]] for r in range(f["h"])]
            payload = b"".join(interlace_rows(rows))
        data += image_block(f["x"], f["y"], f["w"], f["h"], payload, mcs,
                            interlaced=f.get("interlaced", False), lct=f.get("lct"))

        # ---- intent model, in step with the file ----
        if f["disposal"] == 3:
            saved = canvas.copy()
        canvas.draw(f["x"], f["y"], f["w"], f["h"], indices,
                    f.get("lct") or palette, f.get("transparent"))
        expected_frames.append({
            "delayMs": real_delay_ms(f["delay_cs"]),
            "probes": [{"x": x, "y": y, "rgba": canvas.at(x, y)}
                       for (x, y) in (probes_per_frame or [])],
        })
        if f["disposal"] == 2:
            canvas.clear_rect(f["x"], f["y"], f["w"], f["h"])
        elif f["disposal"] == 3 and saved is not None:
            canvas = saved.copy()

    data += b"\x3B"

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    with open(out, "wb") as fh:
        fh.write(bytes(data))

    CORPUS.append({
        "file": name,
        "note": note,
        "width": width,
        "height": height,
        "frameCount": len(frames),
        "delaysMs": [e["delayMs"] for e in expected_frames],
        "frames": expected_frames,
        "bytes": len(data),
    })
    print(f"{name:28} {len(data):5} bytes  {len(frames)} frame(s)  {note}")


def build():
    # 01 -- interlaced, four-pass row ordering.
    # Row y is palette index y, a monotonic grey ramp, so a mis-ordered pass
    # shows up as a non-monotonic column rather than as something subtle.
    ramp = b"".join(bytes([y]) * 16 for y in range(16))
    reverse = b"".join(bytes([15 - y]) * 16 for y in range(16))
    emit("01-interlaced.gif",
         "Interlaced frames: four-pass row ordering, both frames interlaced",
         16, 16, GREY16,
         [{"x": 0, "y": 0, "w": 16, "h": 16, "indices": ramp,
           "delay_cs": 10, "disposal": 1, "interlaced": True},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": reverse,
           "delay_cs": 10, "disposal": 1, "interlaced": True}],
         probes_per_frame=[(0, 0), (0, 1), (0, 7), (0, 8), (0, 15)])

    # 02 -- disposal 2, restore to background.
    # Three squares that never overlap. Each output frame must show exactly one:
    # a decoder that ignores disposal 2 accumulates all three.
    emit("02-disposal-2.gif",
         "Disposal method 2 (restore to background): squares must not accumulate",
         24, 24, P8,
         [{"x": 0, "y": 0, "w": 8, "h": 8, "indices": solid(8, 8, 1),
           "delay_cs": 10, "disposal": 2},
          {"x": 8, "y": 8, "w": 8, "h": 8, "indices": solid(8, 8, 2),
           "delay_cs": 10, "disposal": 2},
          {"x": 16, "y": 16, "w": 8, "h": 8, "indices": solid(8, 8, 3),
           "delay_cs": 10, "disposal": 2}],
         probes_per_frame=[(4, 4), (12, 12), (20, 20)])

    # 03 -- disposal 3, restore to previous.
    # Frame 1 is the state to return to; frame 2 overlays a square and asks for
    # disposal 3; frame 3 must therefore show frame 1's content plus its own,
    # with no trace of frame 2. Rarely implemented, frequently wrong.
    base = bytearray(solid(24, 24, 6))
    for y in range(10, 14):
        for x in range(24):
            base[y * 24 + x] = 1
    emit("03-disposal-3.gif",
         "Disposal method 3 (restore to previous): frame 2's overlay must vanish",
         24, 24, P8,
         [{"x": 0, "y": 0, "w": 24, "h": 24, "indices": bytes(base),
           "delay_cs": 10, "disposal": 1},
          {"x": 8, "y": 8, "w": 8, "h": 8, "indices": solid(8, 8, 2),
           "delay_cs": 10, "disposal": 3},
          {"x": 2, "y": 2, "w": 6, "h": 6, "indices": solid(6, 6, 3),
           "delay_cs": 10, "disposal": 1}],
         probes_per_frame=[(12, 12), (4, 4), (0, 11), (0, 0)])

    # 04 -- per-frame local colour tables that disagree with the global one.
    # Every frame fills with index 1. The global table calls that red; the two
    # local tables call it green and blue. A decoder that ignores local tables
    # renders three identical red frames.
    lct_green = list(P8); lct_green[1] = GREEN
    lct_blue = list(P8); lct_blue[1] = BLUE
    emit("04-local-palettes.gif",
         "Local colour tables overriding the global one at the same index",
         16, 16, P8,
         [{"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 1),
           "delay_cs": 10, "disposal": 1},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 1),
           "delay_cs": 10, "disposal": 1, "lct": lct_green},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 1),
           "delay_cs": 10, "disposal": 1, "lct": lct_blue}],
         probes_per_frame=[(8, 8)])

    # 05 -- sub-rectangle frames at odd offsets and sizes.
    # Deliberately not multiples of 8, and not aligned to each other, so an
    # off-by-one in the row stride lands somewhere visible.
    emit("05-subrect.gif",
         "Sub-rectangle frames at non-zero x/y, smaller than the canvas",
         32, 32, P8,
         [{"x": 0, "y": 0, "w": 32, "h": 32, "indices": solid(32, 32, 0),
           "delay_cs": 10, "disposal": 1},
          {"x": 5, "y": 7, "w": 6, "h": 9, "indices": solid(6, 9, 1),
           "delay_cs": 10, "disposal": 1},
          {"x": 17, "y": 3, "w": 11, "h": 4, "indices": solid(11, 4, 2),
           "delay_cs": 10, "disposal": 1},
          {"x": 20, "y": 20, "w": 12, "h": 12, "indices": solid(12, 12, 3),
           "delay_cs": 10, "disposal": 1}],
         probes_per_frame=[(5, 7), (10, 15), (4, 7), (11, 15),
                           (17, 3), (27, 6), (20, 20), (31, 31)])

    # 06 -- the delay clamp, including its exact boundary.
    # 0cs and 1cs are below the 20ms threshold and must both render as 100ms;
    # 2cs sits exactly on it and must stay 20ms; 5cs passes through unchanged.
    emit("06-delay-zero.gif",
         "Delays 0, 1, 2 and 5 cs: the sub-20ms clamp and its exact boundary",
         16, 16, P8,
         [{"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 1),
           "delay_cs": 0, "disposal": 1},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 2),
           "delay_cs": 1, "disposal": 1},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 3),
           "delay_cs": 2, "disposal": 1},
          {"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 4),
           "delay_cs": 5, "disposal": 1}],
         probes_per_frame=[(8, 8)])

    # 07 -- a single frame with no graphic control extension at all.
    # Exercises the decoder's fallback for a missing GCE, and must be treated as
    # static: a still source contributes no boundaries to the merged timeline.
    emit("07-single-frame.gif",
         "Single frame, no graphic control extension: must be treated as static",
         16, 16, P8,
         [{"x": 0, "y": 0, "w": 16, "h": 16, "indices": solid(16, 16, 5),
           "delay_cs": 0, "disposal": 0, "no_gce": True}],
         probes_per_frame=[(8, 8)])

    # 08 -- first frame smaller than the canvas.
    # A decoder that assumes frame zero covers the canvas leaves the margin
    # opaque or uninitialised; it must be fully transparent here.
    emit("08-first-frame-partial.gif",
         "First frame is not full-canvas: the margin must stay transparent",
         24, 24, P8,
         [{"x": 8, "y": 8, "w": 8, "h": 8, "indices": solid(8, 8, 4),
           "delay_cs": 10, "disposal": 1},
          {"x": 0, "y": 0, "w": 8, "h": 8, "indices": solid(8, 8, 5),
           "delay_cs": 10, "disposal": 1},
          {"x": 16, "y": 0, "w": 8, "h": 8, "indices": solid(8, 8, 6),
           "delay_cs": 10, "disposal": 1}],
         probes_per_frame=[(12, 12), (0, 0), (23, 0), (0, 23), (23, 23)])


if __name__ == "__main__":
    build()
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "expected.json"), "w") as fh:
        json.dump({"files": CORPUS}, fh, indent=1)
        fh.write("\n")
    total = sum(c["bytes"] for c in CORPUS)
    print(f"\n{len(CORPUS)} files, {total} bytes total, plus expected.json")
