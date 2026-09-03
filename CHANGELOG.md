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

### Changed

- `overlay.html` renamed to `index.html` so Pages serves it as the site root. The file still
  opens directly from `file://` — there is still no build step.
