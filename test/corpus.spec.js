// The GIF decoder, checked against the corpus in corpus/.
//
// Three things must agree, and the third is the point:
//
//   1. corpus/expected.json  -- intent, derived from the generator's drawing
//      plan rather than from decoding the output.
//   2. parseGIF + flattenGIF -- the decoder under test.
//   3. ImageDecoder          -- the browser's own GIF decoder.
//
// (3) is worth having precisely because the tool deliberately does not use it
// for GIF: it shares no code with the decoder under test, so it is a witness
// rather than an echo. See PLAN.md section 3.

const { test, expect } = require("./fixtures");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "corpus", "expected.json"), "utf8")
);

const coordsOf = (f) => f.frames[0].probes.map((p) => [p.x, p.y]);
const pixelsOf = (f) => f.frames.map((fr) => fr.probes.map((p) => p.rgba));

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof parseGIF === "function");
});

for (const f of EXPECTED.files) {
  test(`${f.file}: this decoder matches intent`, async ({ page }) => {
    const got = await page.evaluate(async ({ name, probes }) => {
      const buf = await (await fetch(`/corpus/${name}`)).arrayBuffer();
      const gif = parseGIF(buf);
      const flat = flattenGIF(gif);
      return {
        w: gif.width,
        h: gif.height,
        count: flat.length,
        delays: flat.map((fr) => fr.delay),
        probes: flat.map((fr) =>
          probes.map(([x, y]) => {
            const o = (y * gif.width + x) * 4;
            return [fr.data[o], fr.data[o + 1], fr.data[o + 2], fr.data[o + 3]];
          })
        ),
      };
    }, { name: f.file, probes: coordsOf(f) });

    expect(got.w).toBe(f.width);
    expect(got.h).toBe(f.height);
    expect(got.count).toBe(f.frameCount);
    expect(got.delays).toEqual(f.delaysMs);
    expect(got.probes).toEqual(pixelsOf(f));
  });

  test(`${f.file}: the browser's own decoder agrees`, async ({ page }) => {
    const got = await page.evaluate(async ({ name, probes, w, h }) => {
      const buf = await (await fetch(`/corpus/${name}`)).arrayBuffer();
      const dec = new ImageDecoder({ data: buf, type: "image/gif" });
      await dec.tracks.ready;
      try { await dec.completed; } catch {}
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const out = { count: dec.tracks.selectedTrack.frameCount, probes: [], durationsUs: [] };
      for (let i = 0; i < out.count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        out.durationsUs.push(image.duration);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(image, 0, 0);
        out.probes.push(probes.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]));
        image.close();
      }
      dec.close();
      return out;
    }, { name: f.file, probes: coordsOf(f), w: f.width, h: f.height });

    expect(got.count).toBe(f.frameCount);
    // Pixels must match exactly. Durations are deliberately NOT compared here:
    // see the delay-clamp test below for why they are allowed to differ.
    expect(got.probes).toEqual(pixelsOf(f));
  });
}

test("exactly one fixture fills the LZW table, and it is the one meant to", () => {
  // 10-lzw-reset.gif exists to reach the 4096-entry reset, which every other
  // fixture is far too small to touch. make_corpus.py asserts this at
  // generation time; asserting it here holds the *committed* expected.json to
  // it too, so a regeneration that quietly shrank the image below the threshold
  // could not pass by leaving every other test still green.
  const reset = EXPECTED.files.filter((f) => f.lzwResets > 0).map((f) => f.file);
  expect(reset).toEqual(["10-lzw-reset.gif"]);
});

test("loadSource reports a still as static, contributing no duration", async ({ page }) => {
  const got = await page.evaluate(async () => {
    const buf = await (await fetch("/corpus/07-single-frame.gif")).arrayBuffer();
    const file = new File([buf], "07-single-frame.gif", { type: "image/gif" });
    const s = await loadSource(file, () => {});
    const out = { kind: s.kind, frames: s.frames.length, duration: s.duration, static: s.static };
    for (const fr of s.frames) fr.bitmap.close();
    return out;
  });
  expect(got).toEqual({ kind: "gif", frames: 1, duration: 0, static: true });
});

test("loadSource accumulates the clamped delays into starts and duration", async ({ page }) => {
  const got = await page.evaluate(async () => {
    const buf = await (await fetch("/corpus/06-delay-zero.gif")).arrayBuffer();
    const file = new File([buf], "06-delay-zero.gif", { type: "image/gif" });
    const s = await loadSource(file, () => {});
    const out = { delays: s.frames.map((f) => f.delay), starts: s.starts,
                  duration: s.duration, static: s.static };
    for (const fr of s.frames) fr.bitmap.close();
    return out;
  });
  expect(got.delays).toEqual([100, 100, 20, 50]);
  expect(got.starts).toEqual([0, 100, 200, 220]);
  expect(got.duration).toBe(270);
  expect(got.static).toBe(false);
});

// This test exists to stop a "fix".
//
// realDelay() maps anything under 20ms to 100ms because browsers clamp GIF
// delays of 0 or 1 centisecond when they render, and the preview has to match
// the source as *played*, not as written. ImageDecoder reports the raw value,
// so the two disagree on purpose. Anyone who makes these two columns agree has
// broken the preview rather than fixed the decoder -- PLAN.md section 3.
test("the sub-20ms delay clamp diverges from the raw file, deliberately", async ({ page }) => {
  const got = await page.evaluate(async () => {
    const buf = await (await fetch("/corpus/06-delay-zero.gif")).arrayBuffer();

    const gif = parseGIF(buf);
    const raw = gif.frames.map((f) => f.delay);              // centiseconds, as stored
    const clamped = flattenGIF(gif).map((f) => f.delay);      // milliseconds, as played

    const dec = new ImageDecoder({ data: buf, type: "image/gif" });
    await dec.tracks.ready;
    try { await dec.completed; } catch {}
    const native = [];
    for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      native.push(image.duration / 1000);                     // microseconds -> ms
      image.close();
    }
    dec.close();
    return { raw, clamped, native };
  });

  expect(got.raw).toEqual([0, 1, 2, 5]);
  expect(got.native).toEqual([0, 10, 20, 50]);      // what the file literally says
  expect(got.clamped).toEqual([100, 100, 20, 50]);  // what it actually looks like

  // The clamp applies below 20ms and stops exactly at it.
  expect(got.clamped[0]).toBe(100);
  expect(got.clamped[1]).toBe(100);
  expect(got.clamped[2]).toBe(got.native[2]);
  expect(got.clamped[3]).toBe(got.native[3]);
});
