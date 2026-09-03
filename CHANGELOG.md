# Changelog

Notable changes to Overlay. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `corpus/`: eight generated GIFs covering the decoder cases in `PLAN.md` section 6 —
  interlace, disposal 2 and 3, local colour tables, sub-rectangle frames, the sub-20ms delay
  clamp, a still, and a first frame smaller than the canvas. Built by `corpus/make_corpus.py`
  with no imaging library, and verified against both the repository's decoder and the
  browser's own.
- Published at <https://overlay.immanuelqrw.dev> via GitHub Pages.
- `README.md`, `LICENSE` (GPL-3.0), `CHANGELOG.md`.

- Playwright test suite covering the GIF decoder against the corpus, plus a dependency-free
  static server (`test/serve.js`) since the tool now expects a real origin. Mutation-checked:
  removing the delay clamp, the deinterlace call, or disposal-3 restoration each fails exactly
  the fixture built to catch it.
- GitHub Actions CI: runs the browser tests, and fails if `corpus/` is not reproducible from
  `corpus/make_corpus.py`.

- The animated AVIF format note now says macOS Preview and Quick Look cannot open it.

- `verifyBlob()` now covers every output format, not just the coded ones. GIF, WebP, APNG and
  the `MediaRecorder` fallback were being offered unverified. It also asserts the frame count,
  which is what actually catches a truncated GIF or APNG — those decode frame 0 quite happily
  from a partial file.

- `av1ConfigRecord` now consumes `operating_parameters_info()`. It read the per-operating-point
  decoder-model flag but not the payload it introduces, leaving every operating point after the
  first parsed from the wrong bit offset. Latent, since only operating point 0 is used, but it
  would surface the moment anyone parsed further. The parser is split out as
  `parseSequenceHeader` so it can be tested against hand-built headers.

- Cross-browser CI: `degrade.spec.js` runs on Chromium, Firefox and WebKit, checking that the
  format list shrinks honestly rather than offering something that throws on use.
- A source that had to fall back to a single frame now says so in its slot. WebKit has no
  `ImageDecoder`, so an animated WebP, APNG or AVIF arrives as its first frame; it used to do
  that silently.

- A render now draws from a snapshot of the state taken when it started, so nothing changed
  while it runs can land partway through the output. `replan()` defers until the render
  finishes; loading a source is refused while one is running, since disposing the previous
  source closes bitmaps the encoder is still drawing from.

- A Cancel button, shown only while a render is running. It stops between frames, closes the
  `VideoEncoder`, tears down the recorder's capture stream, and offers nothing rather than a
  partial file.

- GIF palette building, quantization and LZW encoding now run in a Worker. The longest
  main-thread block during a large export drops from 136 ms to 18 ms, and no longer grows with
  output size. `npm run bench:gif` measures it.

- A GIF export now says which palette path it took: `Exact palette · N colours, none lost`, or
  `Palette reduced to N colours`. Previously nothing told the user whether their colours had
  survived the encode.

### Changed

- `PLAN.md` section 4 records that all four of its suspects were put in front of third-party
  decoders in #17, #18 and #20, and every one held. The ranking now reads as "where to look
  first if something breaks" rather than a list of probable defects.
- `PLAN.md` section 7's WebAssembly ruling is settled again, on measurement rather than on the
  old dependency rule: nothing published encodes animated AVIF, and the one published animated
  encoder (`webpxmux`, 479 KB brotli) costs ~21× the compressed page to replace the muxer we
  doubt least. The hand-written muxers stay. #20 and #21 are unblocked.
- **The no-build-step, no-dependencies rule is lifted.** The deployed output must still be a
  static site, but a build step and dependencies are now permitted, and `file://` is no longer
  supported. `PLAN.md` section 7's rejection of a WebAssembly encoder rested entirely on that
  rule and is now void pending #34; issues #29 and #32 lost the contortions it forced on them.
- `overlay.html` renamed to `index.html` so Pages serves it as the site root. The file still
  opens directly from `file://` — there is still no build step.
