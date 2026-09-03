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

### Changed

- **The no-build-step, no-dependencies rule is lifted.** The deployed output must still be a
  static site, but a build step and dependencies are now permitted, and `file://` is no longer
  supported. `PLAN.md` section 7's rejection of a WebAssembly encoder rested entirely on that
  rule and is now void pending #34; issues #29 and #32 lost the contortions it forced on them.
- `overlay.html` renamed to `index.html` so Pages serves it as the site root. The file still
  opens directly from `file://` — there is still no build step.
