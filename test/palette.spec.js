// The GIF encoder's two palette paths, and telling the user which one ran (#25).
//
// buildPalette collects distinct opaque colours until it exceeds a cap, then
// falls back to median cut over a 5-bit-per-channel histogram. The cap is 255
// when a transparent index is reserved, which is what the GIF path always does.
//
// The issue asked for the readout to "report loss honestly". There was no
// readout: nothing anywhere told the user whether their colours had survived.
// So these tests cover both halves -- which path runs, and what the user is
// told about it.

const { test, expect } = require("@playwright/test");

// n distinct opaque colours, spread across the RGB cube so the median-cut
// histogram has plenty of occupied bins to work with.
const GEN = `
function spread(n){
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++){
    const h = (i * 2654435761) >>> 0;
    px[i*4] = h & 255; px[i*4+1] = (h >> 8) & 255; px[i*4+2] = (h >> 16) & 255; px[i*4+3] = 255;
  }
  return [px];
}`;

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof buildPalette === "function");
});

test("the boundary sits at 255 distinct colours, not 256", async ({ page }) => {
  const r = await page.evaluate((gen) => {
    eval(gen);
    const at = (n, reserve) => {
      const p = buildPalette(spread(n), reserve);
      return { exact: !!p.exact, count: p.count };
    };
    return {
      // reserve: true is what exportGIF uses -- one index is kept for
      // transparency, so only 255 are left for actual colours.
      r254: at(254, true), r255: at(255, true), r256: at(256, true),
      // Without the reservation the whole 256 are available.
      n256: at(256, false), n257: at(257, false),
    };
  }, GEN);

  expect(r.r254.exact).toBe(true);
  expect(r.r254.count).toBe(254);
  expect(r.r255.exact).toBe(true);
  expect(r.r255.count).toBe(255);
  expect(r.r256.exact).toBe(false);          // one colour past the cap

  expect(r.n256.exact).toBe(true);
  expect(r.n257.exact).toBe(false);
});

test("median cut is bounded by occupied histogram bins, not just by the cap",
  async ({ page }) => {
    const r = await page.evaluate((gen) => {
      eval(gen);
      // Every colour differs, but only in the low bits of red, so they all
      // collapse into the same handful of 5-bit bins.
      const narrow = (n) => {
        const px = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) {
          px[i*4] = i & 255; px[i*4+1] = 0; px[i*4+2] = 7; px[i*4+3] = 255;
        }
        return [px];
      };
      return {
        spread4096: buildPalette(spread(4096), true).count,
        narrow4096: buildPalette(narrow(4096), true).count,
        narrow20000: buildPalette(narrow(20000), true).count,
      };
    }, GEN);

    // Well-distributed colours fill the palette.
    expect(r.spread4096).toBe(255);
    // Clustered ones cannot: median cut splits a 32x32x32 histogram, so it can
    // only produce as many entries as there are occupied bins. Fewer than the
    // cap is correct here, not a truncation bug.
    expect(r.narrow4096).toBe(32);
    expect(r.narrow20000).toBe(32);
  });

test("transparent pixels are not counted as colours", async ({ page }) => {
  const r = await page.evaluate(() => {
    const px = new Uint8ClampedArray(300 * 4);
    for (let i = 0; i < 300; i++) {
      px[i*4] = i & 255; px[i*4+1] = 0; px[i*4+2] = 0;
      // Only 10 opaque; the rest are below the 1-bit alpha threshold.
      px[i*4+3] = i < 10 ? 255 : 100;
    }
    const p = buildPalette([px], true);
    return { exact: !!p.exact, count: p.count };
  });
  // 300 distinct RGB values, but 290 are transparent, so the exact path holds.
  expect(r.exact).toBe(true);
  expect(r.count).toBe(10);
});

// --- the readout ---------------------------------------------------------

async function renderGif(page, outScale) {
  return page.evaluate(async (scale) => {
    async function loadInto(i, name) {
      const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
      const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await loadInto(0, "05-subrect.gif");
    await loadInto(1, "06-delay-zero.gif");
    S.sync = "auto";
    S.outScale = scale;
    replan();

    const sel = document.querySelector("#fmt");
    sel.value = "gif";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#out").innerHTML = "";
    document.querySelector("#render").click();
    const t0 = performance.now();
    while (performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 30));
      if (!document.querySelector("#render").disabled &&
          document.querySelector("#out").innerHTML) break;
    }
    const out = document.querySelector("#out");
    return { text: out.textContent.replace(/\s+/g, " ").trim(),
             ok: !!out.querySelector(".ok"),
             warn: !!out.querySelector(".warn"),
             palette: lastGifPalette };
  }, outScale);
}

test("flat-colour sources take the exact path, and the readout says nothing was lost",
  async ({ page }) => {
    const r = await renderGif(page, 8);
    expect(r.palette.exact).toBe(true);
    expect(r.text).toContain("Exact palette");
    expect(r.text).toContain("none lost");
    expect(r.ok).toBe(true);
  });

// The issue expected scaling *below* 100% to force median cut, on the grounds
// that interpolation manufactures colours. It does, but the colour count is
// also bounded by the pixel count, and shrinking the output cuts that faster
// than blending adds to it. Measured on the corpus pair:
//
//   scale 8   -> 256x256, 93 colours     scale 0.85 -> 26x26, 15 colours
//   scale 4   -> 128x128, 37 colours     scale 0.55 -> 18x18,  9 colours
//   scale 1   ->   32x32,  5 colours     scale 0.3  -> 10x10,  7 colours
//
// So enlarging is what adds colours here, and neither direction gets near 255
// from sources this flat. Recorded rather than asserted as a range, because the
// numbers are a property of these particular fixtures.
test("enlarging adds colours; shrinking does not, despite also interpolating",
  async ({ page }) => {
    const counts = await page.evaluate(async () => {
      async function loadInto(i, name) {
        const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
        const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
        if (S.src[i]) disposeSource(i);
        S.src[i] = src;
      }
      await loadInto(0, "05-subrect.gif");
      await loadInto(1, "06-delay-zero.gif");
      S.sync = "auto"; replan();
      const out = {};
      for (const scale of [8, 1, 0.55]) {
        S.outScale = scale;
        const g = geometry();
        const W = Math.max(2, Math.round(g.w * scale) & ~1);
        const H = Math.max(2, Math.round(g.h * scale) & ~1);
        const R = makeRenderCanvas(W, H, g, false, renderView(S.plan));
        const rgba = [];
        for (let i = 0; i < S.plan.count; i++) {
          R.at(S.plan.times[i] + 1);
          rgba.push(R.cx.getImageData(0, 0, W, H).data);
        }
        out[scale] = buildPalette(rgba, true).count;
      }
      return out;
    });

    expect(counts["1"]).toBeLessThan(counts["8"]);      // enlarging interpolates
    expect(counts["0.55"]).toBeLessThan(counts["8"]);   // shrinking does not help
  });

test("a source with real colour depth forces median cut, and the readout reports loss",
  async ({ page }) => {
    const r = await page.evaluate(async () => {
      // A gradient with a little noise: thousands of distinct colours, which is
      // what actually gets past the 255 cap. Flat cartoon-like sources do not.
      const w = 192, h = 192, frames = [];
      for (let i = 0; i < 4; i++) {
        const c = new OffscreenCanvas(w, h), cx = c.getContext("2d");
        const grad = cx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, `hsl(${i * 40}, 90%, 55%)`);
        grad.addColorStop(1, `hsl(${i * 40 + 180}, 85%, 25%)`);
        cx.fillStyle = grad; cx.fillRect(0, 0, w, h);
        const img = cx.getImageData(0, 0, w, h);
        for (let q = 0; q < img.data.length; q += 4) img.data[q] ^= (q >> 2) & 15;
        cx.putImageData(img, 0, 0);
        frames.push({ bitmap: await createImageBitmap(c), delay: 100 });
      }
      const starts = []; let t = 0;
      for (const f of frames) { starts.push(t); t += f.delay; }
      if (S.src[0]) disposeSource(0);
      S.src[0] = { name: "gradient", kind: "gif", width: w, height: h, frames, starts,
                   duration: t, static: false, thumb: null, meta: "" };

      const buf = await (await fetch("/corpus/06-delay-zero.gif")).arrayBuffer();
      const over = await loadSource(new File([buf], "06.gif", { type: "image/gif" }), () => {});
      if (S.src[1]) disposeSource(1);
      S.src[1] = over;
      S.sync = "auto"; S.outScale = 1; replan();

      const sel = document.querySelector("#fmt");
      sel.value = "gif";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#out").innerHTML = "";
      document.querySelector("#render").click();
      const t0 = performance.now();
      while (performance.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 30));
        if (!document.querySelector("#render").disabled &&
            document.querySelector("#out").innerHTML) break;
      }
      const out = document.querySelector("#out");
      return { text: out.textContent.replace(/\s+/g, " ").trim(),
               warn: !!out.querySelector(".warn"), palette: lastGifPalette };
    });

    expect(r.palette.exact).toBe(false);
    expect(r.palette.colors).toBe(255);
    expect(r.text).toContain("Palette reduced to 255 colours");
    expect(r.text).not.toContain("none lost");
    expect(r.warn).toBe(true);
  });

test("the readout does not carry over from a previous render", async ({ page }) => {
  await renderGif(page, 0.55);                       // leaves a reduced palette
  const r = await page.evaluate(async () => {
    // Any non-GIF format has no palette at all to report.
    const sel = document.querySelector("#fmt");
    const other = FORMATS.find((f) => f.id !== "gif");
    if (!other) return { skipped: true };
    sel.value = other.id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#out").innerHTML = "";
    document.querySelector("#render").click();
    const t0 = performance.now();
    while (performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 30));
      if (!document.querySelector("#render").disabled &&
          document.querySelector("#out").innerHTML) break;
    }
    return { text: document.querySelector("#out").textContent, palette: lastGifPalette };
  });
  test.skip(!!r.skipped, "only one format available");
  expect(r.palette).toBeNull();
  expect(r.text).not.toContain("Palette reduced");
  expect(r.text).not.toContain("Exact palette");
});
