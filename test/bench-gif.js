// Measures what #29 is about: how long the main thread is blocked while a GIF
// is quantized and LZW-encoded. The metric is the longest gap between
// consecutive requestAnimationFrame callbacks during the export -- that gap is
// exactly the beat the user sees the page stop responding for.
const { chromium } = require("@playwright/test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const SIZES = [256, 512, 768];

(async () => {
  const root = path.resolve(__dirname, "..");
  const srv = spawn("node", [path.join(__dirname, "serve.js"), "8936"], { cwd: root, stdio: "ignore" });
  const b = await chromium.launch();
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch("http://localhost:8936/index.html")).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const p = await b.newPage();
    await p.goto("http://localhost:8936/index.html");
    await p.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

    const rows = await p.evaluate(async (sizes) => {
      async function loadInto(i, name) {
        const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
        const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
        if (S.src[i]) disposeSource(i); S.src[i] = src;
      }
      await loadInto(1, "06-delay-zero.gif");

      // A flat-colour source upscaled by an integer factor interpolates
      // nothing, so the palette stays exact and the median-cut path -- the one
      // this issue is about -- never runs. This source is a moving gradient
      // with a little noise, which puts thousands of colours on the canvas.
      async function colourful(w, h, n) {
        const frames = [];
        for (let i = 0; i < n; i++) {
          const c = new OffscreenCanvas(w, h), cx = c.getContext("2d");
          const grad = cx.createLinearGradient(0, 0, w, h);
          grad.addColorStop(0, `hsl(${i * 17}, 90%, 55%)`);
          grad.addColorStop(0.5, `hsl(${i * 17 + 90}, 80%, 35%)`);
          grad.addColorStop(1, `hsl(${i * 17 + 200}, 85%, 20%)`);
          cx.fillStyle = grad; cx.fillRect(0, 0, w, h);
          const img = cx.getImageData(0, 0, w, h);
          for (let q = 0; q < img.data.length; q += 4) {
            img.data[q] ^= (q >> 2) & 15; img.data[q + 1] ^= (q >> 5) & 15;
          }
          cx.putImageData(img, 0, 0);
          frames.push({ bitmap: await createImageBitmap(c), delay: 100 });
        }
        const starts = []; let t = 0;
        for (const f of frames) { starts.push(t); t += f.delay; }
        return { name: "gradient", kind: "gif", width: w, height: h, frames, starts,
                 duration: t, static: false, thumb: null, meta: "" };
      }
      if (S.src[0]) disposeSource(0);
      S.src[0] = await colourful(256, 256, 12);
      S.sync = "auto"; replan();

      const out = [];
      for (const px of sizes) {
        S.outScale = px / 256;
        const g = geometry();
        const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
        const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
        const plan = Object.assign({}, S.plan, {
          count: 36,
          times: Array.from({ length: 36 }, (_, i) => i * 100),
          delaysMs: Array(36).fill(100), delaysCs: Array(36).fill(10), outDur: 3600,
        });

        // Sample the frame clock throughout, and keep the largest gap.
        let maxGap = 0, last = performance.now(), running = true;
        (function sample(){ if (!running) return;
          const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now;
          requestAnimationFrame(sample); })();

        // Which palette path is this exercising? Median cut is the expensive one.
        const probeR = makeRenderCanvas(W, H, g, false, renderView(plan));
        probeR.at(1);
        const probe = buildPalette([probeR.cx.getImageData(0, 0, W, H).data], true);
        const path = probe.exact ? "exact" : "median cut";

        const t0 = performance.now();
        const blob = await exportGIF(W, H, g, plan, () => {}, renderView(plan));
        const total = performance.now() - t0;
        running = false;
        out.push({ px, W, H, path, frames: plan.count, bytes: blob.size,
                   totalMs: Math.round(total), maxBlockMs: Math.round(maxGap) });
      }
      return out;
    }, SIZES);

    console.log(`\n${"output".padEnd(12)}${"palette".padEnd(13)}${"frames".padEnd(8)}${"total ms".padEnd(10)}${"longest block".padEnd(15)}bytes`);
    for (const r of rows)
      console.log(`${(r.W + "x" + r.H).padEnd(12)}${r.path.padEnd(13)}${String(r.frames).padEnd(8)}${String(r.totalMs).padEnd(10)}${(r.maxBlockMs + " ms").padEnd(15)}${r.bytes}`);
  } finally { await b.close(); srv.kill(); }
})();
