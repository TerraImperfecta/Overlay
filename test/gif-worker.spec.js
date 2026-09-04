// GIF quantization and LZW run in a Worker (#29).
//
// The point is that the main thread stops freezing on large outputs, which is a
// timing property and a poor thing to assert in CI. What is worth asserting is
// everything that could quietly break while chasing it: that the bytes are
// unchanged, that the same code still runs when a Worker cannot be created, and
// that progress and cancellation survive the move off-thread.
//
// The measurement itself lives in test/bench-gif.js and is recorded on #29.

const { test, expect } = require("./fixtures");

async function setup(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  return page.evaluate(async () => {
    async function loadInto(i, name) {
      const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
      const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await loadInto(0, "05-subrect.gif");
    await loadInto(1, "06-delay-zero.gif");
    S.outScale = 6;
    S.sync = "auto";
    replan();
    return { count: S.plan.count };
  });
}

const EXPORT = `
async function exportOnce(){
  const plan = S.plan, g = geometry();
  const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
  const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
  const said = [];
  const blob = await exportGIF(W, H, g, plan, t => said.push(t), renderView(plan));
  const b = new Uint8Array(await blob.arrayBuffer());
  let h = 5381;
  for (let i = 0; i < b.length; i++) h = ((h * 33) ^ b[i]) >>> 0;
  return { hash: h + ":" + b.length, said };
}`;

test("the worker produces exactly the bytes the main thread would", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(async (helper) => {
    eval(helper);
    const viaWorker = await exportOnce();

    // Same code, same input, no Worker available.
    const RealWorker = window.Worker;
    let viaMainThread;
    try {
      delete window.Worker;
      viaMainThread = await exportOnce();
    } finally {
      window.Worker = RealWorker;
    }
    return { viaWorker, viaMainThread, workerUsed: typeof RealWorker !== "undefined" };
  }, EXPORT);

  expect(r.workerUsed).toBe(true);
  // A quantizer that disagreed with itself across threads would be a far worse
  // bug than the freeze this was meant to fix.
  expect(r.viaWorker.hash).toBe(r.viaMainThread.hash);
});

test("without a Worker the same code still runs on the main thread", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(async (helper) => {
    eval(helper);
    const RealWorker = window.Worker;
    try {
      delete window.Worker;
      const made = makeGifWorker();          // must decline rather than throw
      const out = await exportOnce();
      return { made, ...out };
    } finally {
      window.Worker = RealWorker;
    }
  }, EXPORT);

  expect(r.made).toBeNull();
  expect(r.hash).toBeTruthy();
  expect(r.said.join(" ")).toContain("Building palette");
});

test("progress is still reported from inside the worker", async ({ page }) => {
  await setup(page);
  const said = await page.evaluate(async (helper) => {
    eval(helper);
    return (await exportOnce()).said;
  }, EXPORT);

  // Compositing moved across too in #63, so this now arrives as a message like
  // the rest of them rather than being said on the way in.
  expect(said.some((t) => t.startsWith("Compositing"))).toBe(true);
  expect(said).toContain("Building palette");
  expect(said.some((t) => t.startsWith("Encoding"))).toBe(true);
  expect(said).toContain("Writing file");
});

test("a render can be cancelled while the worker is encoding", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(async () => {
    const plan = S.plan, g = geometry();
    const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);

    // "Building palette" is the first message that can only have come from the
    // worker, so flipping the flag there proves cancellation reaches across the
    // boundary rather than being caught by the main-thread compositing loop.
    let sawWorkerProgress = false;
    const say = (t) => {
      if (t === "Building palette" || t.startsWith("Encoding")) {
        sawWorkerProgress = true;
        requestCancel();
      }
    };
    let outcome = "resolved";
    try {
      await exportGIF(W, H, g, plan, say, renderView(plan));
    } catch (e) {
      outcome = e && e.cancelled ? "cancelled" : "error: " + e.message;
    } finally {
      renderFinished();
    }
    return { outcome, sawWorkerProgress };
  });

  expect(r.sawWorkerProgress).toBe(true);
  expect(r.outcome).toBe("cancelled");
});

test("the worker source carries every function it needs", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const src = gifWorkerSource();
    return {
      has: ["class BW", "function buildPalette", "function lzwEncode",
            "function encodeGIF", "async function gifFromFrames", "self.onmessage",
            // Compositing runs there too since #63, and must be the same
            // functions the preview draws with rather than a second copy.
            "function frameAt", "function layerBox", "function composite",
            "function renderContext", "function compositeInto"]
            .filter((n) => src.includes(n)),
      // Nothing from the page may leak in: the worker has no S, no DOM, and a
      // reference to either would only fail at run time, on a large export.
      leaks: [/\bS\./, /document\./, /\bwindow\./, /\bbreathe\(/]
            .filter((re) => re.test(src)).map(String),
    };
  });

  expect(r.has).toHaveLength(11);
  expect(r.leaks).toEqual([]);
});

test("with a worker, this thread sends frames to composite, not composited frames",
  async ({ page }) => {
    // The point of #63: 82% of the export's main-thread work was the compositing
    // loop. Byte equality alone would still pass if the frames were quietly
    // being drawn here and shipped across, which is the shape a bad merge takes.
    //
    // What is inspected is the job itself. A module-local call cannot be spied
    // on from out here, but Worker.prototype.postMessage can, and what crosses
    // it is the property: source bitmaps to composite there, not rgba already
    // composited here.
    await setup(page);
    const r = await page.evaluate(async (helper) => {
      eval(helper);
      const real = Worker.prototype.postMessage;
      let job = null;
      Worker.prototype.postMessage = function (m, t) { job = m; return real.call(this, m, t); };
      let withWorker;
      try { withWorker = await exportOnce(); }
      finally { Worker.prototype.postMessage = real; }

      const RealWorker = window.Worker;
      let withoutWorker;
      try { delete window.Worker; withoutWorker = await exportOnce(); }
      finally { window.Worker = RealWorker; }

      return {
        sentAView: !!(job && job.view),
        sentRgba: !!(job && job.rgba),
        frameCount: job && job.view && job.view.src[0] ? job.view.src[0].frames.length : 0,
        sameBytes: withWorker.hash === withoutWorker.hash,
      };
    }, EXPORT);

    expect(r.sentAView).toBe(true);
    // rgba on the job means this thread composited first, which is the bug.
    expect(r.sentRgba).toBe(false);
    expect(r.frameCount).toBeGreaterThan(0);
    // And the fallback still produces the same file.
    expect(r.sameBytes).toBe(true);
  });

test("an export leaves the preview's frames usable", async ({ page }) => {
  // The crux #63 named. An ImageBitmap transferred to a worker is gone from
  // this thread, and the preview draws from these same bitmaps every frame
  // while disposeSource owns them (#26) -- so the worker is given clones. If
  // that ever becomes a transfer, the preview goes black mid-export and the
  // only symptom is a drawImage that throws.
  await setup(page);
  const r = await page.evaluate(async (helper) => {
    eval(helper);
    const bitmaps = S.src.flatMap((s) => s.frames.map((f) => f.bitmap));
    const widthsBefore = bitmaps.map((b) => b.width);
    await exportOnce();

    const widthsAfter = bitmaps.map((b) => b.width);
    let drew = true, err = null;
    try {
      const c = new OffscreenCanvas(8, 8);
      for (const b of bitmaps) c.getContext("2d").drawImage(b, 0, 0);
    } catch (e) { drew = false; err = e.message; }

    // And the preview itself still produces pixels.
    const g = geometry();
    const c = new OffscreenCanvas(g.w, g.h);
    compositeInto(c.getContext("2d"), g.w, g.h, g, 1, false, renderView(S.plan));
    const px = c.getContext("2d").getImageData(0, 0, g.w, g.h).data;
    return { widthsBefore, widthsAfter, drew, err,
             anyPainted: px.some((v) => v !== 0) };
  }, EXPORT);

  // A detached bitmap reports width 0 and throws when drawn.
  expect(r.widthsAfter).toEqual(r.widthsBefore);
  expect(r.widthsAfter.every((w) => w > 0)).toBe(true);
  expect(r.drew, `drawing after the export threw: ${r.err}`).toBe(true);
  expect(r.anyPainted).toBe(true);
});
