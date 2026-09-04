// A transparent background with a partly-transparent overlay, through every
// output format (#24).
//
// The formats are meant to disagree here, and the disagreement is the point:
//
//   GIF        1-bit alpha. Semi-transparent pixels threshold away entirely.
//   WebP/APNG  8-bit alpha. They must survive.
//   AVIF/MP4/WebM  opaque by design; composited onto the background colour.
//
// So the failure being hunted is not "alpha is lost" but "alpha is lost where
// it should not have been", and the background colour is deliberately not black
// so that a format falling back to black instead of honouring it is visible.

const { test, expect } = require("./fixtures");

const BG = "#ff00ff";                     // magenta: nothing else produces it

// Base has large transparent regions, overlay is drawn at 40% over them, so the
// composite carries partial alphas on both sides of GIF's 128 threshold.
const SETUP = `
async function setup(bg){
  async function li(i, n){
    const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
    const s = await loadSource(new File([buf], n, {type:"image/gif"}), () => {});
    if (S.src[i]) disposeSource(i);
    S.src[i] = s;
  }
  await li(0, "02-disposal-2.gif");
  await li(1, "01-interlaced.gif");
  S.bg = bg; S.bgColor = "${BG}"; S.opacity = 0.4; S.outScale = 4; S.sync = "auto";
  replan();
  const g = geometry();
  const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
  const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
  return {g, W, H, plan: S.plan};
}

// Frame 0 of the composite, plus representative pixels to follow through each
// encoder: one that GIF must drop, one it must keep, and one fully transparent.
async function reference(){
  const {g, W, H, plan} = await setup("transparent");
  const R = makeRenderCanvas(W, H, g, false, renderView(plan));
  R.at(plan.times[0] + 1);
  const d = R.cx.getImageData(0, 0, W, H).data;
  let below = -1, above = -1, clear = -1, solid = -1;
  for (let i = 0; i < d.length / 4; i++){
    const a = d[i*4+3];
    if (a === 0 && clear < 0) clear = i;
    else if (a === 255 && solid < 0) solid = i;
    else if (a > 0 && a < 128 && below < 0) below = i;
    else if (a >= 128 && a < 255 && above < 0) above = i;
  }
  const at = i => i < 0 ? null : {x: i % W, y: (i / W) | 0,
                                  rgba: [d[i*4], d[i*4+1], d[i*4+2], d[i*4+3]]};
  return {W, H, g, plan, below: at(below), above: at(above),
          clear: at(clear), solid: at(solid)};
}

async function exportAs(id, W, H, g, plan){
  const f = FORMATS.find(x => x.id === id);
  const say = () => {}, view = renderView(plan);
  if (f.kind === "gif")  return await exportGIF(W,H,g,plan,say,view);
  if (f.kind === "webp") return await exportWebP(W,H,g,plan,say,view);
  if (f.kind === "apng") return await exportAPNG(W,H,g,plan,say,view);
  return await exportCoded(f,W,H,g,plan,say,view);
}

// Decode frame 0 back to pixels, whichever container it is in.
async function firstFrame(blob, mime, W, H){
  const canvas = new OffscreenCanvas(W, H);
  const cx = canvas.getContext("2d", {willReadFrequently: true});
  cx.clearRect(0, 0, W, H);
  if (mime.startsWith("video/")){
    const url = URL.createObjectURL(blob);
    try {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.src = url;
      await new Promise((res, rej) => {
        v.onloadeddata = res; v.onerror = () => rej(new Error("video refused"));
        setTimeout(() => rej(new Error("video timed out")), 8000);
      });
      // loadeddata is not enough: drawImage at that point paints nothing at all,
      // every pixel coming back transparent. A seek asks for a frame to be
      // presented -- but "seeked" only means the seek finished, not that the
      // frame has reached the compositor, so on a loaded machine the draw can
      // still come back blank. That is a flake, and it failed on CI after
      // passing locally and on the PR.
      await new Promise((res, rej) => {
        v.onseeked = res; v.currentTime = 0.001;
        setTimeout(() => rej(new Error("video seek timed out")), 8000);
      });
      // Draw until a frame actually arrives. A blank canvas is all zeroes; any
      // decoded frame of an opaque format has alpha 255 everywhere, so one
      // non-zero byte in a single row is proof something was painted. Probing a
      // row rather than the whole frame keeps the retry cheap.
      //
      // requestVideoFrameCallback is deliberately not used here: on a paused
      // video it does not fire, so it costs its full timeout on every format.
      let painted = false;
      for (let attempt = 0; attempt < 60 && !painted; attempt++){
        cx.clearRect(0, 0, W, H);
        cx.drawImage(v, 0, 0, W, H);
        const row = cx.getImageData(0, 0, W, 1).data;
        for (let i = 0; i < row.length; i++) if (row[i]){ painted = true; break; }
        if (!painted) await new Promise(res => setTimeout(res, 25));
      }
      if (!painted) throw new Error("video never presented a frame to draw");
    } finally { URL.revokeObjectURL(url); }
  } else {
    const dec = new ImageDecoder({data: await blob.arrayBuffer(), type: mime});
    await dec.tracks.ready;
    try { await dec.completed; } catch {}
    const {image} = await dec.decode({frameIndex: 0});
    cx.drawImage(image, 0, 0);
    image.close(); dec.close();
  }
  return cx.getImageData(0, 0, W, H).data;
}
// A declaration, not a const arrow: only function declarations leak out of a
// direct eval into the calling scope.
function px(d, W, p){ const i = (p.y * W + p.x) * 4; return [d[i], d[i+1], d[i+2], d[i+3]]; }
`;

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
});

test("the scenario really does produce partial alpha on both sides of 128",
  async ({ page }) => {
    const r = await page.evaluate(async (setup) => {
      eval(setup);
      const ref = await reference();
      return {below: ref.below, above: ref.above, clear: ref.clear, solid: ref.solid};
    }, SETUP);

    // Without all four the rest of this file would be asserting nothing.
    expect(r.below, "no pixel with alpha below the threshold").not.toBeNull();
    expect(r.above, "no pixel with alpha above the threshold").not.toBeNull();
    expect(r.clear).not.toBeNull();
    expect(r.solid).not.toBeNull();
    expect(r.below.rgba[3]).toBeGreaterThan(0);
    expect(r.below.rgba[3]).toBeLessThan(128);
    expect(r.above.rgba[3]).toBeGreaterThanOrEqual(128);
    expect(r.above.rgba[3]).toBeLessThan(255);
  });

test("GIF thresholds semi-transparent pixels cleanly, keeping nothing in between",
  async ({ page }) => {
    const r = await page.evaluate(async (setup) => {
      eval(setup);
      const ref = await reference();
      const blob = await exportAs("gif", ref.W, ref.H, ref.g, ref.plan);
      const gif = parseGIF(await blob.arrayBuffer());
      const flat = flattenGIF(gif);
      const d = flat[0].data;
      const alphas = new Set();
      for (let p = 3; p < d.length; p += 4) alphas.add(d[p]);
      return {
        alphas: [...alphas].sort((a, b) => a - b),
        below: px(d, ref.W, ref.below), above: px(d, ref.W, ref.above),
        clear: px(d, ref.W, ref.clear),
        disposals: gif.frames.map(f => f.disposal),
        fullFrame: gif.frames.every(f => f.w === gif.width && f.h === gif.height &&
                                         f.x === 0 && f.y === 0),
      };
    }, SETUP);

    // 1-bit alpha: nothing in between is possible, and fringing would show up
    // here as a third value.
    expect(r.alphas).toEqual([0, 255]);
    expect(r.below[3]).toBe(0);        // dropped, as GIF must
    expect(r.above[3]).toBe(255);      // kept, as GIF must
    expect(r.clear[3]).toBe(0);

    // PLAN.md section 3: with a transparent background, disposal 1 cannot erase
    // a pixel going opaque -> transparent, so these frames have to be full-frame
    // with disposal 2. The failure mode is a smear trailing a moving overlay.
    expect(r.fullFrame).toBe(true);
    expect(new Set(r.disposals)).toEqual(new Set([2]));
  });

for (const [id, mime] of [["webp", "image/webp"], ["apng", "image/png"]]) {
  test(`${id} keeps semi-transparent pixels`, async ({ page }) => {
    const r = await page.evaluate(async ({ setup, fid, m }) => {
      eval(setup);
      const ref = await reference();
      const blob = await exportAs(fid, ref.W, ref.H, ref.g, ref.plan);
      const d = await firstFrame(blob, m, ref.W, ref.H);
      let partial = 0;
      for (let p = 3; p < d.length; p += 4) if (d[p] > 0 && d[p] < 255) partial++;
      return { partial, below: px(d, ref.W, ref.below), above: px(d, ref.W, ref.above),
               clear: px(d, ref.W, ref.clear), src: ref.below.rgba[3],
               srcAbove: ref.above.rgba[3] };
    }, { setup: SETUP, fid: id, m: mime });

    // The pixel GIF has to drop must survive here -- that is the whole reason
    // these formats exist in the list.
    expect(r.partial).toBeGreaterThan(0);
    expect(r.below[3]).toBeGreaterThan(0);
    expect(r.below[3]).toBeLessThan(255);
    expect(Math.abs(r.below[3] - r.src)).toBeLessThanOrEqual(4);
    expect(Math.abs(r.above[3] - r.srcAbove)).toBeLessThanOrEqual(4);
    expect(r.clear[3]).toBe(0);
  });
}

test("APNG never leaves pixel (0,0) fully opaque", async ({ page }) => {
  const r = await page.evaluate(async (setup) => {
    eval(setup);
    const ref = await reference();
    const blob = await exportAs("apng", ref.W, ref.H, ref.g, ref.plan);
    const d = await firstFrame(blob, "image/png", ref.W, ref.H);
    return { corner: d[3] };
  }, SETUP);

  // The nudge exists because some PNG encoders drop the alpha channel entirely
  // on a fully opaque frame, which changes IHDR colour type mid-animation and
  // corrupts the APNG. PLAN.md says "nudges to 254"; the code caps at 254, so an
  // already-transparent corner stays transparent. Either way, never 255.
  expect(r.corner).toBeLessThanOrEqual(254);
});

test("the opaque formats composite onto the background colour, not black",
  async ({ page }) => {
    const r = await page.evaluate(async (setup) => {
      eval(setup);
      const ref = await reference();
      const rows = [];
      for (const f of FORMATS.filter(x => x.kind === "iso" || x.kind === "ebml")) {
        const blob = await exportAs(f.id, ref.W, ref.H, ref.g, ref.plan);
        const mime = f.avif ? "image/avif" : (f.ext === "mp4" ? "video/mp4" : "video/webm");
        try {
          const d = await firstFrame(blob, mime, ref.W, ref.H);
          let opaque = true;
          for (let p = 3; p < d.length; p += 4) if (d[p] !== 255) { opaque = false; break; }
          rows.push({ id: f.id, opaque, clear: px(d, ref.W, ref.clear) });
        } catch (e) { rows.push({ id: f.id, error: e.message }); }
      }
      return { rows, bg: [255, 0, 255] };
    }, SETUP);

    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.error, `${row.id}: ${row.error}`).toBeUndefined();
      expect(row.opaque, `${row.id} produced non-opaque pixels`).toBe(true);
      // Where the source was transparent these must show the background colour.
      // Lossy codecs shift it, so this is a "clearly magenta" test rather than
      // an exact match: red and blue high, green low.
      const [red, green, blue] = row.clear;
      expect(red, `${row.id} red`).toBeGreaterThan(140);
      expect(blue, `${row.id} blue`).toBeGreaterThan(140);
      expect(green, `${row.id} green`).toBeLessThan(110);
    }
  });

test("an opaque background lets GIF use inter-frame diffing again", async ({ page }) => {
  const r = await page.evaluate(async (setup) => {
    eval(setup);
    const {g, W, H, plan} = await setup("solid");
    const blob = await exportGIF(W, H, g, plan, () => {}, renderView(plan));
    const gif = parseGIF(await blob.arrayBuffer());
    return {
      disposals: [...new Set(gif.frames.map(f => f.disposal))],
      anySubRect: gif.frames.some(f => f.w < gif.width || f.h < gif.height),
    };
  }, SETUP);

  // The mirror of the transparent case: with an opaque background the encoder
  // is free to emit sub-rectangles with disposal 1, which is where GIF's size
  // saving comes from.
  expect(r.disposals).toEqual([1]);
  expect(r.anySubRect).toBe(true);
});
