# Overlay — handoff

Single-file browser tool that merges two animations into one file on a shared timeline.
Everything is in `index.html`. The **deployed output is a static site** — no server-side code,
nothing to run but files — served over http(s) at <https://overlay.immanuelqrw.dev>.

A build step and dependencies are permitted. They were not, originally, and several decisions
below were made under that older rule; where one of them rested on it, it is now marked and
reopened rather than quietly kept. `file://` is no longer supported: it was a consequence of the
single-file rule, not a goal in itself, and preserving it distorted the code.

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
| 11 | App state, compositing, preview loop, timeline strip rendering |
| 12 | Export entry points, one per container |
| 13 | UI wiring |

---

## 3. Deliberate decisions — do not "fix" these

Each of these looks like an oversight and is not. If you change one, you will reintroduce
a bug that has already been fixed once.

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

**20 ms minimum gap when merging boundaries.** Anything tighter cannot survive GIF's
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

**APNG nudges pixel (0,0) alpha to 254.** Some PNG encoders drop the alpha channel on fully
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
3. **EBML `muxWebM`.** `SimpleBlock` relative timecodes are `int16`, so clusters must break
   before 32767 ms; the current break is at 30000 ms. **Verified in #18** on a 44-second clip:
   two clusters, maximum relative timecode 29600. The margin is structural — the condition is
   `rel > 30000`, so a relative timecode cannot exceed 30000 whatever the frame timing, leaving
   2767 ms of headroom.
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
7. Cancel support: an abort button that closes the `VideoEncoder` and stops the loop. Long
   renders are currently uninterruptible.
8. Move GIF quantization and LZW encoding into a Worker. The median-cut LUT build blocks the
   main thread for a noticeable beat on large outputs.
9. Per-layer placement. Only the overlay can be moved and scaled; the base is pinned at
   natural size. Generalising to two independently placed layers touches `geometry()`,
   `composite()` and the drag handler.
10. Optional Floyd–Steinberg dithering for the GIF path, off by default. Sources are usually
    already quantised, so it mostly inflates file size — hence not built.
11. Persist settings to `localStorage`. Reads and writes still need `try`/`catch` — private
    browsing and blocked site data can throw — but the `file://` hazard is gone.

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

**Sync modes.** Load pairs with these durations and check the mode Auto picks:

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

**Composite.** Blending with a transparent background and opacity below 50% — GIF's 1-bit
alpha thresholds those pixels away entirely. Confirm the WebP and APNG outputs keep them.

**Colour.** An overlay of two GIFs that together use under 255 colours must take the exact
palette path (the readout should not report loss). Scaling output below 100% introduces
interpolation and should push it to median cut.

**Reload behaviour.** Drop three different files into the same slot in succession. The slot
must show exactly one thumbnail each time, the readout must update, and memory must not grow.
Then drop a non-image file and confirm the previous source survives.

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

**Alpha in any AV1-based output.** `VideoFrame` from a canvas is YUV. AVIF alpha requires a
separate auxiliary track. WebP and APNG cover the transparency case.

**`MediaRecorder` for the primary video path.** Real-time capture means a 4-second loop takes
4 seconds per repetition, and frame timestamps come from the wall clock rather than the
timeline. Both defeat the point of the tool.
