# Overlay

A single-file browser tool that merges two animations into one file on a shared timeline.

Two animations stacked in a page drift apart, because each keeps its own clock and browsers
round frame delays differently. Overlay fixes that structurally rather than approximately:
it decodes both sources, builds one merged timeline, and re-encodes the result as a single
file. After that, drift is impossible rather than merely unlikely.

**Live: <https://overlay.immanuelqrw.dev>**

```
load  →  normalise to {bitmap, delay}[]  →  merge timelines  →  composite  →  encode
```

Every source, whatever the format, becomes the same shape — a frame list with per-frame
delays in milliseconds, a cumulative `starts[]` array, and a total `duration`. All downstream
code depends only on that shape.

| | |
|---|---|
| **In** | GIF, animated WebP, APNG, animated AVIF, video (MP4/WebM/MOV/MKV), still images |
| **Out** | GIF, animated WebP, APNG, animated AVIF, MP4 (AV1 / H.264), WebM (VP9 / AV1 / VP8) |

Input decoding uses a hand-written GIF decoder plus `ImageDecoder`; output uses hand-written
muxers over `VideoEncoder`. What the format dropdown offers is probed at runtime, so the list
shrinks rather than throws on browsers with narrower support.

## Layout

```
index.html    the entire tool — markup, styles and script in one file
PLAN.md       outstanding work, and the decisions behind the code
corpus/       generated GIFs that exercise the decoder's awkward cases
test/         Playwright suite, a static server, and the validation tools
```

`npm run fixtures` drives the real app in a real browser and writes one file per
output format to `out/`, alongside the plan they were meant to encode. Add
`-- --stress` for a long, constant-delay plan that reaches the WebM cluster break
and `stts` run-length compression. `test/inspect_container.py` then reads per-frame
timing straight out of an MP4 or WebM.

The script is divided by numbered banner comments, 0–13: icon, GIF decoder, source loader,
timeline merge, GIF quantizer/encoder, WebP muxer, APNG muxer, ISOBMFF muxer (MP4 + AVIF),
EBML muxer (WebM), WebCodecs driver, format registry, app state and compositing, export,
UI wiring. Keep the banners; they are the map.

## Run it

Serve the repository root and open `index.html`:

```
node test/serve.js          # or any static file server
```

Nothing is uploaded anywhere, and the tool makes no network calls of its own — every frame is
decoded, composited and encoded in your browser. The deployed site is static, so the published
copy at <https://overlay.immanuelqrw.dev> is the same file you are looking at.

It needs to be *served* rather than opened from disk: `ImageDecoder` and Workers want a real
origin. Opening `index.html` straight from `file://` is no longer supported.

## Before you change anything

Read section 3 of [`PLAN.md`](PLAN.md). It lists the decisions in this code that look like
oversights and are not — each one is a bug that has already been fixed once. Section 4 ranks
which code is least trustworthy, and section 5 is the ordered task list.

## Licence

GPL-3.0. See [`LICENSE`](LICENSE).
