// Firefox and Safari: the format list must degrade, not throw (issue #19).
//
// This is the one spec that runs on all three engines. The others assert exact
// decoder output and are Chromium-only, because Chromium is where ImageDecoder
// and WebCodecs are complete enough to be an oracle.
//
// So nothing here asserts that a particular format exists. The contract is
// weaker and more useful: whatever buildFormats() decides to offer must
// actually work when the user picks it. A list that advertises a format this
// browser cannot produce is the failure being hunted -- offering nothing is
// merely disappointing, offering something broken is a bug.
//
// A note on what "Safari" means here: Playwright's webkit is a WebKit build,
// not shipping Safari. They differ, most notably on codecs Safari gets from
// system frameworks. Treat a webkit result as evidence about WebKit and a
// strong hint about Safari, not as proof.
//
// CI runs this project on macOS rather than Linux. WebKit's Linux port uses
// different media backends entirely and crashes on this page there, but the
// reason to move it is the stronger one: Safari exists only on Apple platforms,
// so a Linux WebKit result would be weak evidence about Safari even if it ran.

const { test, expect } = require("./fixtures");

async function capabilities(page) {
  return page.evaluate(async () => {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 8;
    const toBlobType = (type) =>
      new Promise((r) => probe.toBlob((b) => r(!!b && b.type === type), type, 0.8));

    const codecs = {};
    if (typeof VideoEncoder !== "undefined") {
      for (const c of ["av01.0.04M.08", "avc1.42E01E", "vp09.00.10.08", "vp8"]) {
        try {
          const r = await VideoEncoder.isConfigSupported({
            codec: c, width: 256, height: 256, bitrate: 1e6, framerate: 30 });
          codecs[c] = !!(r && r.supported);
        } catch (e) { codecs[c] = `threw ${e.name}`; }
      }
    }

    let imageDecoderTypes = null;
    if (typeof ImageDecoder !== "undefined") {
      imageDecoderTypes = {};
      for (const t of ["image/gif", "image/webp", "image/png", "image/avif"]) {
        try { imageDecoderTypes[t] = await ImageDecoder.isTypeSupported(t); }
        catch (e) { imageDecoderTypes[t] = `threw ${e.name}`; }
      }
    }

    return {
      ua: navigator.userAgent,
      ImageDecoder: typeof ImageDecoder !== "undefined",
      VideoEncoder: typeof VideoEncoder !== "undefined",
      MediaRecorder: typeof MediaRecorder !== "undefined",
      OffscreenCanvas: typeof OffscreenCanvas !== "undefined",
      canvasWebP: await toBlobType("image/webp"),
      canvasPNG: await toBlobType("image/png"),
      codecs,
      imageDecoderTypes,
      formats: FORMATS.map((f) => ({ id: f.id, label: f.label, recorder: !!f.recorder })),
    };
  });
}

async function loadSources(page) {
  return page.evaluate(async () => {
    async function loadInto(i, name) {
      const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
      const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await loadInto(0, "05-subrect.gif");
    await loadInto(1, "06-delay-zero.gif");
    S.outScale = 4;
    S.sync = "auto";
    replan();
    return { count: S.plan.count, delaysMs: S.plan.delaysMs };
  });
}

test("the page comes up and probes capabilities without throwing", async ({ page }, testInfo) => {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const caps = await capabilities(page);
  // Recorded rather than asserted: the capability set is the finding, and it is
  // what makes a failure elsewhere in this file interpretable.
  await testInfo.attach("capabilities.json", {
    body: JSON.stringify(caps, null, 1), contentType: "application/json" });
  console.log(`\n[${testInfo.project.name}] ${caps.ua}`);
  console.log(`[${testInfo.project.name}] ImageDecoder=${caps.ImageDecoder} ` +
              `VideoEncoder=${caps.VideoEncoder} MediaRecorder=${caps.MediaRecorder} ` +
              `OffscreenCanvas=${caps.OffscreenCanvas} canvasWebP=${caps.canvasWebP}`);
  console.log(`[${testInfo.project.name}] codecs: ${JSON.stringify(caps.codecs)}`);
  console.log(`[${testInfo.project.name}] formats: ${caps.formats.map((f) => f.id).join(", ")}`);

  expect(problems, `startup problems: ${problems.join(" | ")}`).toEqual([]);
});

test("the format list is never empty and always includes GIF", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  const caps = await capabilities(page);

  // GIF's decoder and encoder are both ours and depend on no browser codec API,
  // which is a large part of why they are hand-written. If GIF ever drops off
  // the list, the probing logic is wrong rather than the browser being narrow.
  expect(caps.formats.length).toBeGreaterThan(0);
  expect(caps.formats.map((f) => f.id)).toContain("gif");
});

test("MediaRecorder is never offered as a format", async ({ page }) => {
  // This used to assert conditionally -- "if any recorder entries exist, they
  // must be labelled and alone" -- and the condition was never true on any
  // engine, so it asserted nothing. #59 forced the branch, measured what it
  // produced, and removed it: the frames land on the capture clock rather than
  // the merged timeline, which is the drift this tool exists to prevent.
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  const caps = await capabilities(page);

  expect(caps.formats.filter((f) => f.recorder)).toEqual([]);
  expect(caps.formats.map((f) => f.label).join(" ")).not.toContain("real time");
});

// One full render per offered format, so the budget has to scale with the list
// rather than sit at Playwright's default. The inner per-format wait must stay
// comfortably below it: when the inner budget is the larger of the two, a stall
// surfaces as "Test timeout exceeded" pointing at page.evaluate, naming nothing.
// That is exactly how this test failed on WebKit, saying only that it was slow.
const PER_FORMAT_MS = 15000;

test("every format the browser offers actually works", async ({ page }, testInfo) => {
  test.setTimeout(PER_FORMAT_MS * 10 + 30000);
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  await loadSources(page);

  const results = await page.evaluate(async (perFormatMs) => {
    const sel = document.querySelector("#fmt"), btn = document.querySelector("#render");
    const out = document.querySelector("#out"), rows = [];
    for (const id of [...sel.options].map((o) => o.value)) {
      sel.value = id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      out.innerHTML = "";
      btn.click();
      const t0 = performance.now();
      let settled = false;
      while (performance.now() - t0 < perFormatMs) {
        await new Promise((r) => setTimeout(r, 100));
        if (!btn.disabled && out.innerHTML) { settled = true; break; }
      }
      const a = out.querySelector("a.dl");
      const warn = out.querySelector(".warn");
      rows.push({ id, settled, ms: Math.round(performance.now() - t0),
                  download: !!a, filename: a ? a.getAttribute("download") : null,
                  message: warn ? warn.textContent.trim() : null });
    }
    return rows;
  }, PER_FORMAT_MS);

  await testInfo.attach("formats.json", {
    body: JSON.stringify(results, null, 1), contentType: "application/json" });
  for (const r of results) {
    console.log(`[${testInfo.project.name}] ${r.id.padEnd(10)} ${String(r.ms).padStart(6)}ms  ` +
                `${r.download ? "ok " + r.filename : "FAILED"}${r.message ? "  — " + r.message : ""}`);
  }

  // Named individually, so a slow or stuck format says which one it was rather
  // than taking the whole test down with an anonymous timeout.
  // An empty collection here would assert nothing at all.
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.settled, `${r.id} did not finish within ${PER_FORMAT_MS}ms`).toBe(true);
    expect(r.download, `${r.id} was offered but produced no download: ${r.message}`).toBe(true);
  }
});

// The branch left over from #21. Chrome 148 supplies no decoderConfig.description,
// so av1ConfigRecord parses the sequence header itself on every AV1 export. If a
// browser ever does supply one, the pass-through path runs instead -- and nothing
// has yet been observed taking it.
test("record whether this browser supplies an AV1 decoderConfig.description",
  async ({ page }, testInfo) => {
    await page.goto("/index.html");
    await page.waitForFunction(() => typeof av1ConfigRecord === "function");

    const result = await page.evaluate(async () => {
      if (typeof VideoEncoder === "undefined") return { supported: false, reason: "no VideoEncoder" };
      let codec = null;
      for (const c of ["av01.0.08M.08", "av01.0.05M.08", "av01.0.04M.08"]) {
        try {
          const r = await VideoEncoder.isConfigSupported({
            codec: c, width: 64, height: 64, bitrate: 2e5, framerate: 10 });
          if (r && r.supported) { codec = c; break; }
        } catch {}
      }
      if (!codec) return { supported: false, reason: "no AV1 encoder" };

      let description = null;
      await new Promise((resolve, reject) => {
        const enc = new VideoEncoder({
          output: (chunk, meta) => {
            if (description === null) {
              const d = meta && meta.decoderConfig && meta.decoderConfig.description;
              description = d ? d.byteLength : 0;
            }
          },
          error: reject,
        });
        enc.configure({ codec, width: 64, height: 64, bitrate: 2e5, framerate: 10 });
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        c.getContext("2d").fillRect(0, 0, 64, 64);
        const vf = new VideoFrame(c, { timestamp: 0, duration: 100000 });
        enc.encode(vf, { keyFrame: true });
        vf.close();
        enc.flush().then(() => { enc.close(); resolve(); }, reject);
      });
      return { supported: true, codec, descriptionBytes: description };
    });

    console.log(`[${testInfo.project.name}] AV1 description: ${JSON.stringify(result)}`);
    await testInfo.attach("av1-description.json", {
      body: JSON.stringify(result, null, 1), contentType: "application/json" });

    // Both answers are legitimate -- the point is to find out which branch each
    // engine takes -- so neither is asserted. What is asserted is that the probe
    // itself still works: `expect(result).toBeTruthy()` stood here, and an
    // object is always truthy, so a probe that started returning nothing useful
    // would have gone on passing.
    expect(typeof result.supported).toBe("boolean");
    if (result.supported) {
      expect(result.codec).toMatch(/^av01\./);
      expect(result.descriptionBytes === null ||
             typeof result.descriptionBytes === "number").toBe(true);
    } else {
      expect(result.reason).toBeTruthy();
    }
  });

// Input decoding degrades too, and less visibly than the format list does.
//
// decodeImage() uses ImageDecoder for WebP, APNG and AVIF, and falls back to
// createImageBitmap(file) when it is missing -- which yields exactly one frame.
// So on an engine without ImageDecoder, loading an animated WebP or APNG gets
// you its first frame and nothing else. That is graceful in the sense that
// nothing throws, and lossy in the sense that the animation is gone.
//
// Round-tripped through the app's own APNG encoder so no fixture is needed:
// export six frames, feed the result back in, count what comes out.
test("an animated non-GIF input degrades to a still without ImageDecoder",
  async ({ page }, testInfo) => {
    await page.goto("/index.html");
    await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
    await loadSources(page);

    const result = await page.evaluate(async () => {
      const hasDecoder = typeof ImageDecoder !== "undefined";
      const plan = S.plan, g = geometry();
      const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
      const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
      const apng = await exportAPNG(W, H, g, plan, () => {});
      // Through accept(), not loadSource directly: accept() rewrites src.meta,
      // so testing the inner call would have missed the note being clobbered.
      await accept(1, new File([apng], "round-trip.png", { type: "image/png" }));
      const back = S.src[1];
      const slot = document.querySelector('.slot[data-i="1"] .meta');
      return { hasDecoder, expected: plan.count, kind: back.kind,
               frames: back.frames.length, static: back.static,
               meta: back.meta, slotText: slot ? slot.textContent : "" };
    });

    console.log(`[${testInfo.project.name}] APNG round-trip: ` +
                `ImageDecoder=${result.hasDecoder} -> ${result.frames} of ${result.expected} ` +
                `frames, kind=${result.kind}, static=${result.static}`);

    if (result.hasDecoder) {
      expect(result.frames).toBe(result.expected);
      expect(result.static).toBe(false);
      expect(result.meta).not.toContain("ImageDecoder");
    } else {
      // The documented consequence, asserted so it cannot change silently.
      expect(result.frames).toBe(1);
      expect(result.kind).toBe("still");
      expect(result.static).toBe(true);
      // And the slot has to say why, or the user just sees an animation that
      // arrived as a single frame for no stated reason.
      expect(result.meta).toContain("no ImageDecoder");
      // And it has to survive as far as the slot the user actually reads.
      expect(result.slotText).toContain("no ImageDecoder");
    }
  });
