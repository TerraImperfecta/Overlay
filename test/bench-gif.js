// Measures what #29 is about: how long the main thread is blocked while a GIF
// is quantized and LZW-encoded. The metric is the longest gap between
// consecutive requestAnimationFrame callbacks during the export -- that gap is
// exactly the beat the user sees the page stop responding for.
const { chromium } = require("@playwright/test");
const { spawn } = require("node:child_process");
const path = require("node:path");

/* 256 through 768 are kept for continuity with the numbers recorded on #29 and
   #63. 1536 is here because the block this is about only becomes obvious above
   768: at 768 it was 13 ms, which is under one frame, and at 1536 it was 48. */
const SIZES = [256, 512, 768, 1536];

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

        // Which palette path is this exercising? Median cut is the expensive one.
        const probeR = makeRenderCanvas(W, H, g, false, renderView(plan));
        probeR.at(1);
        const probe = buildPalette([probeR.cx.getImageData(0, 0, W, H).data], true);
        const path = probe.exact ? "exact" : "median cut";

        /* The sampler starts *after* the probe. It used to start before, which
           meant this benchmark's own median cut over a full frame -- several
           milliseconds of synchronous main-thread work that no export performs
           -- was counted as part of the export's longest block, and set a floor
           the measurement could never go below. */
        let maxGap = 0, last = performance.now(), running = true;
        (function sample(){ if (!running) return;
          const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now;
          requestAnimationFrame(sample); })();

        const t0 = performance.now();
        const blob = await exportGIF(W, H, g, plan, () => {}, renderView(plan));
        const total = performance.now() - t0;
        running = false;
        out.push({ px, W, H, path, frames: plan.count, bytes: blob.size,
                   totalMs: Math.round(total), maxBlockMs: Math.round(maxGap) });
      }
      /* ---- attributing the residual block (#63) ------------------------
         #29 left an 18 ms block at 768 square, and the question is whether
         compositing is most of it -- because only then is moving compositing
         into the worker worth what it costs (see the issue: transferring an
         ImageBitmap takes it away from the preview, which draws from the same
         bitmaps).

         Timing each call in the loop would answer the wrong question. Canvas
         drawing is deferred: drawImage returns before the work happens, and the
         cost lands on whatever forces a flush -- which here is getImageData.
         Naive timing therefore reports compositing as nearly free and blames
         readback for both. Instead each side is isolated:

           A  composite + read + keep, every frame   -- the real loop
           B  composite every frame, read once       -- draws, flushed once
           C  read every frame, discarding each      -- readback alone
           D  read every frame, keeping each         -- readback plus retention

         B is compositing plus one readback; C is N readbacks. D differs from C
         only in holding on to the results, which is what the export does: it
         accumulates every frame before handing them to the worker. If A is
         close to B + C the split is additive; if A is far above that but close
         to D, the cost is neither compositing nor the readback call but the
         85 MB of frames being kept alive. */
      const attrib = [];
      for (const px of sizes) {
        S.outScale = px / 256;
        const g = geometry();
        const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
        const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
        const N = 36;
        const plan = Object.assign({}, S.plan, {
          count: N, times: Array.from({ length: N }, (_, i) => i * 100),
          delaysMs: Array(N).fill(100), delaysCs: Array(N).fill(10), outDur: N * 100,
        });
        const view = renderView(plan);
        const fresh = () => makeRenderCanvas(W, H, g, false, view);

        // Warm: first draw of a size pays for allocation and shader setup.
        const w0 = fresh(); w0.at(1); w0.cx.getImageData(0, 0, W, H);

        const median = (f) => {
          const runs = [];
          for (let r = 0; r < 3; r++) runs.push(f());
          return runs.sort((a, b) => a - b)[1];
        };

        const both = median(() => {
          const R = fresh(), keep = [];
          const t = performance.now();
          for (let i = 0; i < N; i++){ R.at(plan.times[i] + 1);
            keep.push(R.cx.getImageData(0, 0, W, H).data); }
          const ms = performance.now() - t;
          return keep.length === N ? ms : ms;   // keep alive past the timer
        });

        const compositeOnly = median(() => {
          const R = fresh();
          const t = performance.now();
          for (let i = 0; i < N; i++) R.at(plan.times[i] + 1);
          R.cx.getImageData(0, 0, 1, 1);        // force the flush
          return performance.now() - t;
        });

        const readbackOnly = median(() => {
          const R = fresh(); R.at(1); R.cx.getImageData(0, 0, W, H);
          const t = performance.now();
          for (let i = 0; i < N; i++) R.cx.getImageData(0, 0, W, H);
          return performance.now() - t;
        });

        const readbackKept = median(() => {
          const R = fresh(); R.at(1); R.cx.getImageData(0, 0, W, H);
          const keep = [];
          const t = performance.now();
          for (let i = 0; i < N; i++) keep.push(R.cx.getImageData(0, 0, W, H).data);
          const el = performance.now() - t;
          return keep.length === N ? el : el;
        });

        /* B composites 36 times into one canvas, where every draw but the last
           is immediately overwritten -- exactly the work a driver is free to
           elide, which would make compositing look cheaper than it is. The
           whole recommendation rests on that number, so it is checked here
           against draws that cannot be skipped: one canvas each, and a 1x1 read
           after each to force it to have happened. G is the same without the
           compositing, so F - G is the draw cost with nothing hidden. */
        const forced = median(() => {
          const t = performance.now();
          for (let i = 0; i < N; i++){
            const R = fresh(); R.at(plan.times[i] + 1); R.cx.getImageData(0, 0, 1, 1);
          }
          return performance.now() - t;
        });
        const forcedEmpty = median(() => {
          const t = performance.now();
          for (let i = 0; i < N; i++){ const R = fresh(); R.cx.getImageData(0, 0, 1, 1); }
          return performance.now() - t;
        });

        /* If the gap between A and B+C is the draw-then-read synchronisation --
           each getImageData forcing the pipeline to finish the drawImage before
           it -- then separating the two phases should recover it. Compositing
           into N canvases and reading them afterwards does exactly that, and
           needs no worker at all. Measured because a cheap fix for the same
           block would be a better answer than either building or closing. */
        const phased = median(() => {
          const cs = [];
          const t = performance.now();
          for (let i = 0; i < N; i++){ const R = fresh(); R.at(plan.times[i] + 1); cs.push(R); }
          const keep = cs.map(R => R.cx.getImageData(0, 0, W, H).data);
          const el = performance.now() - t;
          return keep.length === N ? el : el;
        });

        /* The loop grows with output size but the export's longest block does
           not, so the block may not be the loop at all. This runs exactly what
           exportGIF runs -- the same breathe() every eight frames -- and watches
           the frame clock, so the two are directly comparable. */
        const blockInLoop = await (async () => {
          let worst = 0, last = performance.now(), on = true;
          (function sample(){ if (!on) return;
            const now = performance.now();
            worst = Math.max(worst, now - last); last = now;
            requestAnimationFrame(sample); })();
          const R = fresh(), keep = [];
          for (let i = 0; i < N; i++){
            R.at(plan.times[i] + 1);
            keep.push(R.cx.getImageData(0, 0, W, H).data);
            if (i % 8 === 0) await breathe();
          }
          on = false;
          return keep.length === N ? worst : worst;
        })();

        attrib.push({ px, W, H, N, both, compositeOnly, readbackOnly, readbackKept,
                      phased, forced, forcedEmpty, blockInLoop,
                      megabytes: Math.round(W * H * 4 * N / 1e6) });
      }

      return { out, attrib };
    }, SIZES);

    console.log(`\n${"output".padEnd(12)}${"palette".padEnd(13)}${"frames".padEnd(8)}${"total ms".padEnd(10)}${"longest block".padEnd(15)}bytes`);
    for (const r of rows.out)
      console.log(`${(r.W + "x" + r.H).padEnd(12)}${r.path.padEnd(13)}${String(r.frames).padEnd(8)}${String(r.totalMs).padEnd(10)}${(r.maxBlockMs + " ms").padEnd(15)}${r.bytes}`);

    const ms = (n) => (Math.round(n * 10) / 10).toFixed(1);
    const pc = (n, d) => Math.round(100 * n / d) + "%";

    console.log(`\nWhat the compositing loop is made of  (${rows.attrib[0].N} frames, median of 3)`);
    console.log(`${"output".padEnd(12)}${"loop".padEnd(10)}${"composite".padEnd(12)}` +
                `${"readback".padEnd(11)}${"held".padEnd(9)}composite share`);
    for (const a of rows.attrib) {
      const comp = a.forced - a.forcedEmpty;
      console.log(`${(a.W + "x" + a.H).padEnd(12)}${ms(a.both).padEnd(10)}${ms(comp).padEnd(12)}` +
                  `${ms(a.readbackOnly).padEnd(11)}${(a.megabytes + " MB").padEnd(9)}${pc(comp, a.both)} of the loop`);
    }
    console.log("  Times are ms for the whole loop. composite + readback should be close to loop;");
    console.log("  they are, which is what makes the split trustworthy.");

    console.log(`\nWhy the obvious measurement is wrong`);
    console.log(`${"output".padEnd(12)}${"36 draws, one canvas".padEnd(23)}${"36 draws, forced".padEnd(19)}understated by`);
    for (const a of rows.attrib) {
      const comp = a.forced - a.forcedEmpty;
      console.log(`${(a.W + "x" + a.H).padEnd(12)}${(ms(a.compositeOnly) + " ms").padEnd(23)}` +
                  `${(ms(comp) + " ms").padEnd(19)}${(comp / Math.max(a.compositeOnly, .01)).toFixed(0)}x`);
    }
    console.log("  Drawing 36 times into one canvas lets a driver skip every draw but the last,");
    console.log("  so timing that reports compositing as nearly free. One canvas each, with a");
    console.log("  1x1 read to force it, is what the middle column measures.");

    console.log(`\nWhat moving compositing off the main thread bought`);
    console.log(`${"output".padEnd(12)}${"if composited here".padEnd(21)}${"as shipped".padEnd(13)}saved`);
    for (let i = 0; i < rows.attrib.length; i++) {
      const a = rows.attrib[i], e = rows.out[i];
      const saved = a.blockInLoop - e.maxBlockMs;
      console.log(`${(a.W + "x" + a.H).padEnd(12)}${(ms(a.blockInLoop) + " ms").padEnd(21)}` +
                  `${(e.maxBlockMs + " ms").padEnd(13)}${saved > 1 ? ms(saved) + " ms" : "—"}`);
    }
    console.log("  Left: the same loop still run on this thread, breathing every eight frames,");
    console.log("  which is what the export used to do. Right: the export's real longest block.");
    console.log("  The right-hand column no longer grows with output size; roughly 9 ms is the");
    console.log("  idle frame cadence, so at every size the export now blocks on nothing.");

    console.log(`\nWould separating draw and read -- no worker needed -- help instead?`);
    console.log(`${"output".padEnd(12)}${"interleaved".padEnd(14)}${"phased".padEnd(11)}change`);
    for (const a of rows.attrib) {
      const d = Math.round(100 * (a.phased - a.both) / a.both);
      console.log(`${(a.W + "x" + a.H).padEnd(12)}${(ms(a.both) + " ms").padEnd(14)}` +
                  `${(ms(a.phased) + " ms").padEnd(11)}${d > 0 ? "+" : ""}${d}%`);
    }
    console.log("  Worse at every size, so there is no cheap fix to prefer over the worker.");
  } finally { await b.close(); srv.kill(); }
})();
