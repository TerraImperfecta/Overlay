# Overlay — handoff

Browser tool that merges two animations into one file on a shared timeline. `index.html` is
the markup, `styles.css` the styles, and `js/` the script — one file per numbered section. The
**deployed output is a static site** — no server-side code, nothing to build, nothing to run but
files — served over http(s) at <https://overlay.immanuelqrw.dev>.

A build step and dependencies are permitted. They were not, originally, and several decisions
below were made under that older rule; where one of them rested on it, it is now marked and
reopened rather than quietly kept. `file://` is no longer supported: it was a consequence of the
single-file rule, not a goal in itself, and preserving it distorted the code. The single file
itself is gone too — split in #75 — but no build step arrived with it, and none is wanted.

**The scripts are ES modules** (#78). `index.html` loads `js/main.js` and the import graph does
the rest, so load order is not something to get right by hand. `main.js` re-exports every module
for the test suite, which reaches the code by name; nothing in the app imports from it.

Three things to know before editing:

- **A module cannot assign another module's binding.** The shared mutable state — `busy`,
  `cancelling`, `queuedReplan`, `lastGifPalette`, `pausedAt`, `zoom` — lives in `js/11-app.js`
  and is changed through `renderStarted()`, `renderFinished()`, `requestCancel()`,
  `takeQueuedReplan()`, `setLastGifPalette()`, `togglePlay()` and `resetZoom()`.
- **`gifWorkerSource()` stringifies functions**, and the worker it builds has no imports and no
  page. Anything listed there may reference only what is listed alongside it. `Function.prototype
  .toString()` does *not* include the `export` keyword, so that part is unaffected — but a
  declaration written *inside* the worker's template literal is source text, not a declaration,
  and must not be given one.
- **Module-local functions cannot be replaced from outside**, which a test needs in order to
  substitute a broken encoder. `EXPORTERS` in `js/12-export.js` is the dispatch table `render()`
  goes through, and is that seam.

What has *not* changed: no user data leaves the browser. There are no network calls in the
tool's own operation, and there is nothing to upload to.

---

## 1. What it does

Two animations stacked in a page drift apart because each keeps its own clock, and browsers
round frame delays differently. The fix is structural: decode both, build a single merged
timeline, re-encode as one file. After that, drift is impossible rather than merely unlikely.

Pipeline:

```
load  →  normalise to {bitmap, delay}[]  →  merge timelines  →  composite  →  encode
```

Every source, whatever the format, becomes the same shape: a frame list with per-frame
delays in milliseconds, plus a cumulative `starts[]` array and a total `duration`. All
downstream code depends only on that shape.

---

## 2. Layout of `index.html`

The script is divided by numbered banner comments. Keep them; they are the map.

Each row is a file in `js/`, named for its number and contents, and an ES module.

| Section | Contents |
|---|---|
| 0 | Runtime icon rasterisation (SVG data URI → `apple-touch-icon`) |
| 1 | GIF decoder: LZW, interlace, disposal methods, frame flattening |
| 2 | Universal source loader: GIF / `ImageDecoder` / video / stills |
| 3 | Timeline merge — the core of the tool |
| 4 | GIF quantizer (exact palette or median cut) + GIF encoder |
| 5 | Animated WebP muxer |
| 6 | APNG muxer |
| 7 | ISOBMFF muxer → MP4 and animated AVIF, plus AV1 sequence-header parsing |
| 8 | EBML muxer → WebM |
| 9 | WebCodecs encode driver + output self-verification |
| 10 | Format registry with capability probing |
| 11 | App state, compositing, preview loop and zoom, timeline strip rendering |
| 12 | Export entry points, one per container |
| 13 | UI wiring |

---

## 3. Deliberate decisions — do not "fix" these

Each of these looks like an oversight and is not. If you change one, you will reintroduce
a bug that has already been fixed once.

**The GIF parser bounds its own block walks.** The sub-block chain is length-prefixed, and
walking it without checking the buffer length does not fail — it loops forever. Past the end
`d[p]` is `undefined`, `p += 1 + undefined` makes `p` NaN, `d[NaN]` is `undefined`, and the tab
freezes. Two loops had this shape and each froze on a different input; both are now bounded and
throw. Fixed in #55, with a test per malformed input whose real assertion is that it returns at
all.

**Declared dimensions are checked before anything allocates.** A header may claim any size up to
65535 a side and nothing downstream questions it. The dangerous case is not 65535 square, which
wants 17 GB and throws promptly; it is around 16000 square, which wants a gigabyte *per frame*
and succeeds, slowly. The caps — 16384 a side, 64 megapixels — are policy rather than format
limits, sized so one decoded frame stays under a quarter of a gigabyte. Real GIFs are orders of
magnitude below both.

**Own GIF decoder instead of `ImageDecoder`.** `ImageDecoder` is used for WebP, AVIF and
APNG but deliberately *not* for GIF. The hand-written decoder gives exact per-frame delays,
works in browsers without WebCodecs, and applies the browser delay-clamping rule
consistently. Do not "simplify" by routing GIF through `ImageDecoder`.

**`realDelay()` maps delays under 20 ms to 100 ms.** This is not a bug. Browsers clamp GIF
delays of 0 or 1 centisecond to roughly 100 ms, and the preview must match what the source
actually looks like when played. Removing this makes fast GIFs decode "correctly" and
preview wrongly.

**The timeline is in milliseconds; only GIF quantises to centiseconds.** `plan.delaysMs`
is authoritative. `plan.delaysCs` exists solely for `encodeGIF` and is derived with an
error accumulator so rounding does not drift across the loop. Do not make `delaysMs` a
multiple of 10 — that regression existed and was removed.

**Boundaries are the union of both sources' frame changes, not a fixed sample rate.**
Fixed-fps resampling fights both sources' timing. Uniform resampling only kicks in when the
union exceeds the frame budget. Keep that ordering.

**20 ms minimum gap when merging boundaries.** Note the corollary, established in #23: because
the merge guarantees at least 20 ms between boundaries, a plan can hold at most `outDur / 20`
of them, so resampling only runs when `maxFrames` is *below* that — which means
`outDur / maxFrames` is already at least 20. The `Math.max(20, ...)` inside the resampling step
can therefore never change its value. It is unreachable, and no fixture can make it fire; kept
because it stops being unreachable the moment this floor changes. Anything tighter cannot survive GIF's
centisecond timing and produces frames no renderer will honour.

**Sampling uses `plan.times[i] + 1`, never `plan.times[i]`.** The `+1` ms epsilon puts the
sample *inside* the interval rather than exactly on a boundary, where `frameAt` could
resolve to either neighbouring frame. Same reason for `snapped += 1` in the preview loop.

**Frames are stored as `ImageBitmap`, not `ImageData`.** Raw `Uint8ClampedArray` frames blew
up memory once video inputs were supported (hundreds of megabytes for a short clip).
`ImageBitmap` is GPU-backed and draws faster. `disposeSource()` must keep calling `.close()`
on every bitmap.

**`disposeSource(i)` runs only after the new source decodes successfully.** Disposing first
means a failed load leaves the slot empty and destroys the working file the user already had.

**`input.value = ""` before `input.click()`.** Without it, re-picking the same file fires no
`change` event and the UI appears frozen.

**`renderSlot(i)` rebuilds the whole slot from state.** The original code patched innerHTML
in place, which appended a second thumbnail on every reload and leaked object URLs. Never go
back to querying and replacing individual children.

**Output dimensions are forced even via `& ~1`.** H.264 and AV1 reject odd dimensions.

**APNG caps pixel (0,0) alpha at 254.** Not "sets to 254" — the code is `Math.min(a, 254)`, so
an already-transparent corner stays transparent. What matters is that it is never 255. Removing
the cap makes that corner come back fully opaque, so this is load-bearing today rather than
vestigial; #24 has a test. Some PNG encoders drop the alpha channel on fully
opaque frames, producing a different `IHDR` colour type mid-animation, which corrupts the
APNG. The nudge guarantees a consistent alpha channel. The visual cost is one pixel at 99.6%
opacity.

**ANMF flags byte is `2` (blending: none).** With blending enabled, transparent regions
composite over the previous frame instead of replacing it, and anything with alpha smears.

**`av1ConfigRecord` hardcodes 8-bit 4:2:0 non-monochrome.** Only `seq_profile`,
`seq_level_idx` and `seq_tier` are parsed from the sequence header. This is safe because
canvas-sourced `VideoFrame`s are always 8-bit 4:2:0. If someone ever adds HDR or 10-bit
input, the colour-config fields must then be parsed properly.

**`muxISOBMFF` builds the header twice.** The first pass with `mdatOffset = 0` exists only to
measure the header length. This works because every offset field is fixed-width, so the size
cannot change between passes. Do not try to patch offsets in place instead.

**GIF inter-frame diffing only runs when the background is opaque.** With a transparent
background, disposal method 1 cannot erase a pixel that goes opaque → transparent, so those
frames must be full-frame with disposal 2.

**`MediaRecorder` is a fallback, not a path.** It only appears in the format list when no
`VideoEncoder` codec is available at all, and is labelled "(real time)". Do not promote it.

**Output is verified before it is offered.** `verifyBlob()` feeds AVIF back through
`ImageDecoder` and video through a `<video>` element. This exists because the muxers were
written without access to a real decoder. Do not remove it as "unnecessary overhead".

---

## 4. Highest-risk code

The muxers in sections 6, 7 and 8 were written from specification without being run against a
real decoder. That was true when this was written; it is no longer. Issues #17, #18 and #20
put all four suspects below in front of third-party decoders — `gifsicle`, `webpinfo`,
`pngcheck`, `avifdec` and Apple's ImageIO — and **every one of them held**. Per-frame timing
matches `plan.delaysMs` exactly in every format, `stts` compresses correctly in both shapes,
and the WebM cluster break is structurally bounded rather than merely lucky.

Keep the ranking below for orientation, but read it now as "where to look first if something
breaks", not as a list of probable defects. Rank your suspicion in this order:

1. **Animated AVIF** (`buildMetaBox`, `muxISOBMFF` with `avif: true`). Most structurally
   complex, least forgiving. `iloc` offsets, `ipma` property associations and the `avis` brand
   list are the likely failure points. The `meta` box carries a primary still item whose
   `iloc` extent points at the same bytes as sample zero in `mdat`. When hunting a wrong offset
   here, `@browser-mc/webcodecs-avif` (30 KB, WebCodecs rather than wasm) exports `muxStillAvif`
   and builds these same still-item boxes; diffing against a working implementation beats
   rereading the specification. It cannot replace our animated path — see section 7 — but it is
   a useful oracle for this box.

   **Verified in #20.** The extent aliases sample zero exactly, `infe` declares `av01`, and
   `av1C` is correctly essential in `ipma`. macOS Preview still will not open the file, and
   that is not this code's fault: Apple's ImageIO gates on the *major brand* and rejects
   anything branded `avis`, including a still that libavif itself produced once relabelled.
   Relabelling ours to `avif` makes macOS read it — and makes libavif see one frame instead of
   six. `avis` is correct and stays.
2. **`av1ConfigRecord` sequence-header parsing.** This entry had it backwards, and #17 caught
   it: **Chrome 148 never supplies `decoderConfig.description`**, so far from hiding, this
   parser runs on *every* AV1 export and its output is load-bearing for animated AVIF,
   MP4 · AV1 and WebM · AV1 alike. The dormant branch is the other one — a browser that *does*
   supply a description, which nothing here has yet been seen to do.

   The `timing_info` and `decoder_model_info` branches were still the fiddly part, and one of
   them was wrong. `operating_parameters_info()` follows `decoder_model_present_for_this_op`
   and is `2 × buffer_delay_length + 1` bits; the parser read the flag and skipped the payload,
   so every operating point after the first came from the wrong bit offset. Nothing noticed,
   because only operating point 0 is used and its level and tier are read before the mistake —
   which is exactly the kind of latent fault that surfaces the moment someone parses further,
   as the HDR or 10-bit work noted in section 3 would have to. **Fixed and tested in #21**,
   against hand-built headers covering the branches Chrome never emits.

   `Bits.uvlc()` had a second arithmetic fault, **fixed in #57**. The offset was `(1<<z)-1`,
   and `1<<31` is negative in JavaScript, so z = 31 returned −2147483649 where the value is
   2147483647 — and the guard stopped at `z > 31`, which left 31 itself permitted and wrong.
   The offset is `(2 ** z) - 1` now.

   Two things worth knowing before touching it again. The **value is discarded** — it is read
   once, for `num_ticks_per_picture_minus_1` — so what this mostly has to get right is *how many
   bits it consumes*; a wrong count desynchronises every field after it, which is the shape the
   `operating_parameters_info` bug had. And the old `z > 31` bail-out was **load-bearing as a
   loop bound**: `f()` returns 0 past the end of the buffer, so a reader looking for a
   terminating 1 that is not there never finds one and hangs the tab. The bound is the buffer
   now, and running out throws; 32 or more leading zeros is a legal encoding of the maximum and
   returns 2³²−1 with the terminating 1 consumed, per spec.
3. **EBML `muxWebM`.** `SimpleBlock` relative timecodes are `int16`, so clusters must break
   before 32767 ms; the current break is at 30000 ms. **Verified in #18** on a 44-second clip:
   two clusters, maximum relative timecode 29600. The margin is structural — the condition is
   `rel > 30000`, so a relative timecode cannot exceed 30000 whatever the frame timing, leaving
   2767 ms of headroom.

   **Corroborated by FFmpeg in #58.** #18 checked this with `test/inspect_container.py`, which is
   a second implementation rather than an outside authority — a shared misreading of the spec
   would fool it and the muxer alike. `test/validate_containers.py` now reads the same files with
   **libavformat 62.12**, which is what `ffprobe` is a thin CLI over, and agrees on **every
   timestamp to 0.000 ms** — both MP4s and all three WebM variants, in the normal export and in
   the 55-frame stress export that crosses a cluster break. Two independent readings of the same
   bytes now say the same thing.

   PyAV supplies libavformat in its wheels, so this needs no system package — which is what had
   blocked it: Homebrew has dropped Intel x86_64, and the development machine's Homebrew is the
   Intel one.

   Keep the pairing. Our parser is the one that can say *why* — "two clusters, relative timecodes
   reset at 30400, maximum 29600 against a limit of 32767" — and libavformat is the one whose
   agreement means something.
4. **ISOBMFF sample tables.** `stts` run-length compression and the single-chunk `stsc`/`stco`
   arrangement. **Verified in #18** in both shapes: uneven delays produce one entry per sample
   (nothing to compress), 55 identical delays produce a single `(55, 800)` entry.

If a container fails verification, dump the blob to disk and run it through `ffprobe`,
`mp4box -info`, or `avifdec` before touching the code. The error message from a real parser
will point at the box far faster than reading the spec again.

---

## 5. Ordered task list

**Verification first. Do not add features before these pass.**

1. Confirm each format in the dropdown renders and downloads in Chrome. Record which ones
   fail `verifyBlob` and how.
2. Validate the muxed files externally: `ffprobe` for MP4/WebM, `avifdec` or `ffprobe` for
   AVIF, `webpinfo` for animated WebP, `pngcheck -v` for APNG. Confirm frame counts and
   per-frame durations match `plan.delaysMs` exactly.
3. ~~Test in Firefox and Safari.~~ **Done in #19**, and automated: `test/degrade.spec.js` runs
   on Chromium, Firefox and WebKit. Firefox offers all nine formats. WebKit has no
   `ImageDecoder` and no canvas WebP encoding, so it correctly offers eight — WebP drops out —
   and all eight work. The list shrinks rather than lying, which was the requirement.

   The one thing that degrades *invisibly* is input: without `ImageDecoder`, `decodeImage()`
   falls back to `createImageBitmap`, so an animated WebP, APNG or AVIF loads as its first
   frame alone. The slot now says why. Note that Playwright's webkit is a WebKit build rather
   than shipping Safari; they differ most on codecs Safari gets from system frameworks.
4. Confirm the AVIF `meta`/`iloc` path by opening the output in a viewer that shows the still
   fallback (macOS Preview, or `avifdec --index 0`).
5. Exercise `av1ConfigRecord`'s parser deliberately — temporarily force `description` to
   `null` in `exportCoded` and confirm MP4·AV1 still plays.

**Then, in rough priority order:**

6. Add a busy guard so `replan()` cannot fire mid-render and swap `S.plan` under the encoder.
7. ~~Cancel support.~~ **Done in #28.** Every encode loop already paused at `await idle()` to
   keep the page responsive; those are now `await breathe()`, the same yield plus a check for
   whether Cancel was pressed. Cancellation therefore lands between frames rather than
   part-way through writing one, and needs no new plumbing through the encoders.
8. ~~Move GIF quantization and LZW encoding into a Worker.~~ **Done in #29.** The longest
   main-thread block during a 36-frame export went from 34 / 69 / 136 ms at 256² / 512² / 768²
   to a flat 16 / 15 / 18 ms — what remains is the compositing loop, which needs the canvas and
   so stays put. The worker source is assembled from the existing functions with
   `Function.prototype.toString`, so there is one implementation rather than two, and it falls
   back to running the same code on the main thread where a Worker cannot be created.
   `npm run bench:gif` reproduces the figures.
9. ~~Per-layer placement.~~ **Done in #30.** Both layers carry a `{scale, x, y}` in one shared
   space, still measured in base-natural units so the defaults mean exactly what the old pinned
   behaviour meant — untouched placement produces byte-identical output.

   The canvas rule, which was the real question in that issue: **Base size** is the base's
   placed rectangle, so scaling the base scales the output and moving it slides the overlay
   underneath rather than resizing anything; **Fit both** is the union of the two placed
   rectangles. A Base/Overlay selector decides what the size slider and preview dragging act on.

   Note `geometry()` normalises `-0`, which negating a zero offset produces. Harmless to draw
   with, but it is not what the function used to return and `Object.is` can tell.
10. ~~Optional Floyd–Steinberg dithering for the GIF path.~~ **Measured and ruled out in #31 —
    see section 7.** It was implemented, measured, and the implementation reverted; the numbers
    are in section 7 so nobody has to build it again to find out.
11. ~~Persist settings to `localStorage`.~~ **Done in #32.** Output format, quality, output
    scale, opacity, sync mode, background and background colour, and nothing derived from a
    loaded file — not the sources, and not layer placement, whose coordinates are fractions of
    a base that will not be there next time.

    Everything read back is treated as hostile and validated field by field, so one bad value
    costs that setting rather than all of them, and a stored format the current browser cannot
    produce falls back to whatever `buildFormats()` chose. Reads and writes are wrapped because
    some browsers *throw* on touching `localStorage` rather than returning null; there is a test
    that makes the accessor throw and confirms the app still starts and its controls still work.
    Reading settings never writes them, so an untouched visit leaves no trace.
12. ~~Interface design pass.~~ **Done in #65.** The visual language was fine; the weighting was
    not. Five things changed:

    The preview was sized to the source and capped at 560px, so a 32×32 GIF was drawn 32px wide
    inside an 840px panel — the subject of the tool, and the thing being dragged, was the
    smallest element on the page. It now fits its panel, with the scale shown and −/+/Fit
    controls. Above 1:1 the scale is a whole number so a source pixel stays square under
    `image-rendering:pixelated`.

    **The canvas is `position:absolute` inside `.stage`, and must stay that way.** In flow it is
    a flex item, so fitting it to the panel made the panel taller, which made the fit larger,
    which made the canvas bigger again. That loop settled at different scales in Chromium and
    WebKit and ran to the 32× ceiling in Firefox, which made it look like a browser quirk rather
    than a loop. There is a test asserting the computed `position`.

    The fit scale is whatever the panel allows and so is rarely one of the fixed zoom steps;
    `zoomLadder()` splices it in, or stepping out of fit and back would land somewhere else.

    Zoom is a property of looking, not of the file: it is not persisted and not part of the
    render snapshot. Dragging converts pointer pixels through the *displayed* width, so zooming
    in makes a drag finer rather than wrong — asserted, because a hard-coded size would look
    right until someone zoomed.

    The columns are `align-items:stretch`, so the left one no longer stops around 830px against
    the right's 1560. Stacked under 860px the preview stops growing, or it would push every
    control off the screen.

    **Yellow means the output and nothing else** — the OUTPUT lane, the plan's output figures,
    Render, and the finished file's download link. It used to be the active segmented state,
    every slider fill, the primary button *and* the OUTPUT lane, which is why it emphasised
    nothing. Pink is base and cyan is overlay, including in the layer selector. A test
    enumerates every element computing to that yellow and fails if one is not part of the
    output; a rule like this decays silently otherwise.

    `--a` as *text* was 4.48:1 on `--panel` and 3.98:1 on `--panel-2`, both under AA. `--a-ink`
    is the same pink lightened until the worst ground passes; `--a` stays the saturated fill for
    lanes and swatches. The check is a test, not a comment.
13. ~~Keyboard and numeric placement.~~ **Done in #61.** Dragging on the preview was the only
    way to set `place[i].x/y`, so a keyboard user could reach every other control and then not
    do the one thing the tool is for. Arrow keys nudge the selected layer by one base pixel and
    Shift by ten; the canvas is focusable, described, and announces where a layer landed.

    **The units were the real decision.** Placement is stored as the layer's *centre*, as a
    fraction of the base's natural size, because that survives the base being swapped for one of
    a different size — but nobody thinks in those units. The fields read the **top-left corner in
    base pixels**, which is what "16 pixels from the left edge" means.

    Base pixels rather than output pixels, which sound more natural: in **Fit both** the canvas
    origin moves when the overlay does, so a typed `0` would not read back as `0`. With the
    default base placement the two are identical anyway, and `geometry().dx` is 0 — there is a
    test for each half of that.

    `setLayerPos` ignores a non-finite coordinate per axis, because a field mid-edit is briefly
    `""` and then briefly `"-"`; parsing those as 0 threw the layer into the corner while
    someone was still typing.

    Every way a layer can move now ends in `placementChanged()`, which refreshes the fields
    **synchronously**. They were originally left to the animation loop, like the zoom label —
    but `requestAnimationFrame` does not run in a background tab and is throttled well below the
    rate a held key repeats, so the number went stale while the layer moved. A test reads the
    field with no `await` at all, so no frame can have been drawn.

    `syncPlacementFields` skips any input that has focus, or the loop would rewrite the first
    digit before the second could be typed.
14. ~~Undo and redo for placement.~~ **Done in #62.** Placement only — position and scale, both
    layers. Format, quality, sync mode and the rest are single controls whose previous value is
    visible in the control itself and which persist between visits (#32), so a general stack
    would be a much larger commitment for much less benefit. If that changes, it is a new issue.

    Entries are whole placement states, not deltas: two layers of three numbers each costs
    nothing to copy, and restoring a snapshot cannot drift the way replaying inverse operations
    can. `sel` travels with the state, so an undo selects the layer it just restored — otherwise
    the size slider and the position fields would describe a layer that did not change.

    **Coalescing is the property that makes it usable.** A `beginChange(key)` opens a gesture and
    records the state from before it; a run of changes with the same key inside `COALESCE_MS`
    (700 ms) extends that gesture rather than starting one. So a twelve-move drag, a held arrow
    key and the three digits of a typed number are each one step. A history with one entry per
    `pointermove` is worse than none, because undo appears not to work.

    `endChange` discards a gesture that ended where it started, so a drag that never moved and a
    field re-typed to the same number do not cost an undo press that does nothing.

    `undo()` calls `endChange()` before reading the stack, so it works immediately after a drag
    with nothing in between. For the same reason the Undo *button* asks `canUndo()`, which counts
    an open gesture: reading `past.length` alone made the button claim there was nothing to undo
    while Ctrl+Z would have undone it.

    **`setPointerCapture` must stay last in the pointerdown handler, and stay wrapped.** It
    throws on a pointer id the browser does not recognise, and it used to run *before*
    `beginChange`, so the throw silently cost the drag its history entry while the drag itself
    carried on working. Firefox found that; Chromium and WebKit did not.
15. **Measured whether compositing belongs in the Worker (#63) — it does.** `npm run bench:gif`
    now attributes the block that #29 left behind. At 768² over 36 frames:

    | | ms | share |
    |---|---|---|
    | the compositing loop | 51.9 | |
    | └ compositing | 42.4 | **82% of the loop** |
    | └ readback (`getImageData`) | 14.9 | 29% of the loop |

    Compositing and readback sum to roughly the loop, which is what makes the split
    trustworthy.

    **One figure in the first version of this entry was wrong.** It said the loop was 83% of
    the export's longest block, from a `maxBlockMs` that started its sampler *before* the
    benchmark's own palette probe — a median cut over a full frame, several ms of synchronous
    work no export performs, setting a floor the measurement could never go below. Corrected in
    #16, which also showed the real block was 13 ms at 768², under one frame at 60 Hz. The
    attribution above never depended on it.

    **Do not measure this the obvious way.** Timing a loop that composites 36 frames into one
    canvas reports compositing as *nearly free* — 1.2 ms rather than 44.4 ms, understating it
    **37×** — because every draw but the last is immediately overwritten and a driver is free to
    skip them. The first version of this benchmark did exactly that and concluded compositing
    was 2% of the loop, which would have closed the issue on an artifact. The honest measurement
    gives each frame its own canvas and forces the draw with a 1×1 read.

    Two negative results worth keeping. Separating the draw and read phases — the fix that needs
    no worker at all — is **worse** at every size (+19% to +41%), so there is no cheap
    alternative to prefer. And retaining the 85 MB of frames costs nothing measurable: reading
    36 frames and keeping them matches reading and discarding them, so the accumulation is not
    the problem.

    What remains is the obstacle the issue already named: every `ImageBitmap` transferred to a
    worker is gone from the main thread, where the preview draws from those same bitmaps and
    `disposeSource` owns them (#26). The measurement says the prize is real; it does not make
    that cheaper.
16. ~~Composite in the Worker.~~ **Done in #63.** The export's longest block no longer grows
    with output size:

    | output | composited here | as shipped |
    |---|---|---|
    | 256² | 1.3 ms | 9 ms |
    | 512² | 9.3 ms | 9 ms |
    | 768² | 19.5 ms | 9 ms |
    | 1536² | **49.1 ms** | **10 ms** |

    Roughly 9 ms is the idle frame cadence, so at every size the export now blocks on nothing.
    Below 768² there was never anything to win — which is why 1536 was added to the benchmark's
    sizes. At 768² alone this looks marginal, and that is the size #63 was argued from.

    **The bitmaps are cloned, not transferred, and that must stay true.** An `ImageBitmap` sent
    with a transfer list is gone from this thread, where the preview draws from those same
    bitmaps every frame and `disposeSource` owns them (#26) — the preview would go black
    mid-export, and the only symptom would be a `drawImage` that throws. Cloning turns out to be
    nearly free: `postMessage` with 36 frames across took **0.7 ms**, because a browser
    refcounts the underlying surface rather than copying pixels. There is a test that draws
    every source bitmap after an export.

    `composite`, `layerBox`, `frameAt`, `renderContext` and `compositeInto` are carried into the
    worker as source, the way #29 carried the quantizer. Two implementations of compositing was
    the trap to avoid, and `renderContext` exists so the OffscreenCanvas and the element cannot
    drift on `imageSmoothingEnabled` or the alpha flag — which would show up as different output
    bytes rather than as an error. The equality test from #29 covers exactly that.

    `exportGIF` now takes its own snapshot when the caller omits one. The view used to be
    optional because `composite()` fell back to reading `S` live, and there is no `S` in a
    worker.

---

## 6. Test corpus

**GIF decoder.** Each of these has broken a GIF decoder before:

- Interlaced GIF (four-pass row ordering)
- Frames using disposal method 2 (restore to background)
- Frames using disposal method 3 (restore to previous) — rare, often mishandled
- Per-frame local colour tables that differ from the global table
- Sub-rectangle frames where `x`/`y` are non-zero and `w`/`h` are smaller than the canvas
- A frame with delay 0 (must render as 100 ms)
- A single-frame GIF (must be treated as static, contributing no boundaries)
- A GIF whose first frame is not full-canvas

**Sync modes.** ~~Load pairs with these durations and check the mode Auto picks.~~ **Confirmed
in #23**, and automated — every row below is a test, and each forced mode overrides Auto. The
sources are built with exact durations rather than taken from the corpus, whose GIFs are all
the wrong length for this.

Auto's rule, for reference when reading the table: `lcm` when the LCM is at most 12 s *and*
neither source repeats more than 12 times inside it; `stretch` otherwise.

| Base | Overlay | Expected | Why |
|---|---|---|---|
| 1000 ms | 1000 ms | `lcm`, 1000 ms | identical, trivial |
| 1200 ms | 800 ms | `lcm`, 2400 ms | clean 2:3 loop |
| 1230 ms | 800 ms | `stretch` | LCM would be 98 s |
| 5000 ms | 100 ms | `stretch`, 50 reps | large integer ratio |
| still | 2000 ms | 2000 ms | static contributes no boundaries |
| still | still | 1000 ms | both static, arbitrary duration |

Also force each mode manually and confirm the timeline strip's three lanes line up with the
readout.

**Composite.** ~~Blending with a transparent background and opacity below 50%.~~ **Confirmed
in #24**, and automated. GIF's frame 0 comes back with alpha values of exactly `{0, 255}` and
nothing between, so the thresholding is clean rather than fringed; a pixel at alpha 102 is
dropped and one at 152 is kept. WebP and APNG preserve both within 4 of the source value.

Note the composite only carries partial alpha where the *base* is transparent — blending an
overlay over an opaque base yields opaque, whatever the opacity. The fixture uses
`02-disposal-2.gif`, whose frames are small squares on a transparent canvas, for that reason.

The opaque formats were checked against a magenta background rather than the default black, so
that a format ignoring `bgColor` and filling black is visible instead of indistinguishable.

**Colour.** ~~Scaling output below 100% introduces interpolation and should push it to median
cut.~~ **Corrected in #25.** Two things here were wrong.

The boundary is 255, not "under 255": the exact path holds *at* 255 distinct opaque colours
and gives way at 256, because one index is reserved for transparency. Transparent pixels are
not counted at all, so an image can carry hundreds of RGB values and still take the exact path.

And scaling *down* does not force median cut — it usually does the opposite. Interpolation does
manufacture colours, but the count is also bounded by the number of pixels, and shrinking the
output cuts that faster than blending adds to it. On the corpus pair: ×8 gives 93 colours, ×1
gives 5, ×0.55 gives 9. **Enlarging** is what adds colours. Reaching 256 at all needs a source
with real colour depth, not a scale change.

Median cut is also bounded by its 32×32×32 histogram, so it returns fewer than 255 entries when
the colours cluster into few bins. That is correct, not truncation.

The readout the original entry assumed exists now does: a GIF export reports either
`Exact palette · N colours, none lost` or `Palette reduced to N colours`.

**Reload behaviour.** ~~Drop three different files into the same slot in succession.~~
**Confirmed in #26**, and automated through the drop handler rather than by calling `accept()`,
so the assertions run over what the user actually gets.

"Memory must not grow" is checked as a property rather than a measurement: after eight reloads,
the only `ImageBitmap`s still open are the ones belonging to the source on screen. A closed
bitmap reports width 0, which makes that exact. Heap size is too noisy to assert on and is only
reported.

The related invariant — `input.value = ""` before `input.click()` — cannot be reached through
the picker, which is not scriptable. The test watches for the assignment itself instead, since
reading `input.value` proves nothing: it is `""` either way until a file has been chosen.

---

## 7. Ruled out, with reasons

Don't re-litigate these without new information.

**Remuxing still AVIFs into an animation.** The trick that works for WebP and APNG cannot work
here. Those formats define an animation as a list of complete still-image payloads — `ANMF`
wraps a whole VP8/VP8L bitstream, `fdAT` wraps a whole PNG `IDAT` stream. Animated AVIF is an
ISOBMFF *video track* whose frames are inter-coded samples, while a still AVIF stores its
picture as an image *item* under `iloc`/`iprp`. Different storage models; no concatenation
path exists. Hence the `VideoEncoder` route.

**A WebAssembly encoder (libavif, libwebp).** Rejected on measurement, not on a dependency
rule — that rule is gone and does not belong in this argument. Investigated in #34; the numbers
are here so nobody has to run it again.

*Nothing published encodes animated AVIF.* `@jsquash/avif` exports `encode` and `decode` for a
single image and nothing else — grep its package for `anim`, `addImage`, `sequence` or
`frameCount` and you get no hits. Every other AVIF package on npm is the same, including
`@browser-mc/webcodecs-avif`, whose entry point is literally `muxStillAvif`. A still-image
encoder does not help, for the reason in the entry directly above: still AVIF and animated AVIF
are different storage models with no concatenation path, and that is just as true of someone
else's stills as of ours. So the code section 4 ranks *least* trustworthy has no off-the-shelf
replacement at any price.

*The one animated encoder that does exist replaces the muxer we doubt least.* `webpxmux`
(`encodeFrames`, with a per-frame `duration`, so timing would survive) writes animated WebP and
costs **479 KB brotli**. `index.html` is **22 KB gzipped** in total — the whole application.
That is roughly **21× the compressed page** to replace the `ANMF` path, which section 4 does
not even list among its suspects.

MP4, WebM and APNG stay ours under any of these options. This was never going to be a clean
sweep.

Reconsider only if #20 concludes the hand-written AVIF muxer cannot be fixed. The route then is
a custom Emscripten build of libavif with image-sequence support — `avifEncoderAddImage` does
take per-frame durations — which means owning a toolchain and a multi-megabyte aom payload,
because nobody has published such a build.

**Floyd–Steinberg dithering for GIF.** Built in #31, measured, and reverted. It works — the
banding median cut leaves across a gradient really does disappear — but it is the wrong answer
to that problem.

| source | plain GIF | dithered GIF | WebP | APNG |
|---|---|---|---|---|
| photographic, 240×240 | 42,317 | **204,207** (+383%) | **32,506** | 1,329,832 |
| flat, upscaled 320×320 | 5,938 | **20,218** (+240%) | **3,090** | 20,586 |

**WebP is smaller than the undithered GIF in both cases**, and has no palette at all, so there
is no banding for it to dither away. Dithered GIF costs roughly 6× WebP's size to approximate
what WebP does natively. Anyone reaching for GIF is choosing it for reach, which is precisely
when a 4.8× file cannot be afforded; anyone who can spend those bytes should be picking WebP.

One correction while here: the old entry said dithering "mostly inflates file size" because
sources are already quantised, and item 8's reasoning blamed inter-frame diffing. Neither is
quite right. An already-quantised source takes the *exact* palette path, where dithering never
runs at all. And the diffing damage is small — changed pixels between consecutive frames went
from 51.7% to 56.7% on the photographic case, and 29.4% to 29.7% on the flat one. What
dithering actually destroys is **LZW compression within each frame**: the noise it adds breaks
up the runs the encoder depends on. Same conclusion, different mechanism.

Reopen only with a case where GIF is mandatory, the content is genuinely photographic, and the
banding matters more than a fivefold file size. `git log` has the implementation.

**Alpha in any AV1-based output.** `VideoFrame` from a canvas is YUV. AVIF alpha requires a
separate auxiliary track. WebP and APNG cover the transparency case.

**`MediaRecorder` for the primary video path.** Real-time capture means a 4-second loop takes
4 seconds per repetition, and frame timestamps come from the wall clock rather than the
timeline. Both defeat the point of the tool.
