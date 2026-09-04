# Overlay

A browser tool that merges two animations into one file on a shared timeline.

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
index.html    the markup, and the script tags that load the rest
styles.css    every style in the tool
js/           the script, one file per numbered section
PLAN.md       outstanding work, and the decisions behind the code
corpus/       generated GIFs that exercise the decoder's awkward cases
test/         Playwright suite, a static server, and the validation tools
```

`npm run fixtures` drives the real app in a real browser and writes one file per
output format to `out/`, alongside the plan they were meant to encode. Add
`-- --stress` for a long, constant-delay plan that reaches the WebM cluster break
and `stts` run-length compression. `test/inspect_container.py` then reads per-frame
timing straight out of an MP4 or WebM.

That parser is ours, so it corroborates rather than confirms. `test/validate_containers.py`
reads the same files with FFmpeg's own demuxer — what `ffprobe` is a thin CLI over — and
checks every timestamp against the plan they were exported from:

```
python3 -m venv .venv && .venv/bin/pip install av   # PyAV ships libavformat
npm run fixtures && npm run fixtures -- --stress
.venv/bin/python test/validate_containers.py
```

`js/` is one file per concern, named for what it holds: `icon`, `gif-decoder`, `source-loader`,
`timeline`, `gif-encoder`, `webp`, `apng`, `isobmff` (MP4 + AVIF), `webm`, `webcodecs`, `formats`,
then the app layer as `state`, `geometry`, `compositing`, `history`, `controls`, `preview` and
`plan`, then `export` and `ui` — plus `util.js`, which holds the three helpers everything uses.

The files were numbered `00-`–`13-` until #86. The numbers were load order when `index.html` had
one script tag per file; once imports decided that, they described nothing — and they were not
even a layering, since `gif-encoder` and `webcodecs` both legitimately import from the app layer.

They are **ES modules**. `index.html` loads one script, `js/main.js`, and the import graph
decides what else loads and in what order — there is no ordering to get right by hand, and
still no build step. `main.js` also re-exports everything, which is how the test suite reaches
the code; nothing in the app imports from it.

Two consequences worth knowing before editing. A module cannot assign another module's binding,
so a mutable value always lives in the file that changes it, and shared state — whether a render
is running, whether one was cancelled — is changed through named functions rather than by
assignment. `test/modules.spec.js` enforces that, along with no import cycles and no module
orphaned from the entry.
And `gifWorkerSource()` builds a Worker by stringifying functions, so anything it lists must
reference only what is listed alongside it; the worker has no imports and no page.

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
