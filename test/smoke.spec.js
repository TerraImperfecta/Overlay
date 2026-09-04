// Does the page come up at all, and does capability probing produce a sane
// format list? PLAN.md section 5 item 3 wants the dropdown to *shrink* on a
// narrower browser rather than offer something that throws on use, so the
// assertions here are about shape, not about a fixed list of formats.

const { test, expect } = require("@playwright/test");

test("the page loads without console errors or unhandled rejections", async ({ page }) => {
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  expect(problems).toEqual([]);
});

test("capability probing yields a usable format list", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const formats = await page.evaluate(() => FORMATS.map((f) => ({
    id: f.id, label: f.label, ext: f.ext, kind: f.kind, recorder: !!f.recorder,
  })));

  // GIF has no WebCodecs dependency -- its decoder and encoder are ours -- so
  // it must be present in every browser, always.
  expect(formats.some((f) => f.id === "gif")).toBe(true);

  // Every entry needs the fields the export path reads.
  for (const f of formats) {
    expect(f.label).toBeTruthy();
    expect(f.ext).toMatch(/^[a-z0-9]+$/);
    expect(f.kind).toBeTruthy();
  }

  // MediaRecorder is a fallback, not a path: it may only appear when no
  // VideoEncoder codec was found at all, and must say so in its label.
  const recorders = formats.filter((f) => f.recorder);
  if (recorders.length) {
    expect(formats.filter((f) => !f.recorder && f.kind !== "gif").length).toBe(0);
    for (const r of recorders) expect(r.label).toContain("real time");
  }

  // The selected default should be the best available, not merely the first.
  const selected = await page.evaluate(() => document.querySelector("#fmt").value);
  expect(selected).toBe(formats.some((f) => f.id === "webp") ? "webp" : "gif");
});

test("the icon rasterises without leaving the page broken", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page).toHaveTitle(/Overlay/);
  const linked = await page.evaluate(
    () => !!document.querySelector('link[rel="icon"], link[rel="apple-touch-icon"]')
  );
  expect(linked).toBe(true);
});

// --- the split into files (#75) --------------------------------------------
//
// The tool was one file until #75. Splitting it introduced two failures that a
// single file could not have: a script the page asks for and does not get, and
// scripts that arrive in the wrong order. Neither is loud. A 404 on one file
// leaves the others running and only breaks whatever needed that one, which may
// be a format nothing on this page touches until you export it.

test("every file the page asks for is served", async ({ page }) => {
  const missing = [];
  page.on("response", (r) => {
    if (!r.ok()) missing.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const asked = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll("script[src]")].map((s) =>
      new URL(s.src).pathname),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
      new URL(l.href).pathname),
  }));

  expect(missing).toEqual([]);
  // A guard against the opposite mistake: a tag quietly dropped from the page
  // would make this test pass by asking for nothing.
  expect(asked.scripts.length).toBeGreaterThanOrEqual(15);
  expect(asked.styles).toContain("/styles.css");
});

test("the scripts leave one shared global scope behind", async ({ page }) => {
  // Not decoration: gifWorkerSource() builds a worker by stringifying functions
  // that have to resolve each other, and the suite reaches the code through
  // these names. Modules would take both away.
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const missing = await page.evaluate(() => {
    const wanted = {
      "util.js": ["$", "esc", "idle"],
      "01 gif decoder": ["parseGIF", "flattenGIF", "lzwDecode"],
      "02 source loader": ["loadSource", "disposeSource"],
      "03 timeline": ["planTimeline"],
      "04 gif encoder": ["buildPalette", "lzwEncode", "encodeGIF", "gifFromFrames"],
      "07 isobmff": ["parseSequenceHeader", "Bits"],
      "09 webcodecs": ["verifyBlob"],
      "10 formats": ["FORMATS", "buildFormats"],
      "11 app": ["S", "geometry", "layerBox", "composite", "renderView", "undo", "redo"],
      "12 export": ["exportGIF", "gifWorkerSource", "makeGifWorker"],
      "13 ui": ["replan", "render"],
    };
    const out = {};
    for (const [where, names] of Object.entries(wanted)) {
      const gone = names.filter((n) => {
        try { return eval("typeof " + n) === "undefined"; } catch { return true; }
      });
      if (gone.length) out[where] = gone;
    }
    return out;
  });

  expect(missing).toEqual({});
});

test("styles arrive from the stylesheet, not from the markup", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const r = await page.evaluate(() => ({
    inlineStyleTags: document.querySelectorAll("style").length,
    ground: getComputedStyle(document.body).backgroundColor,
    tokenSet: getComputedStyle(document.documentElement)
      .getPropertyValue("--ground").trim(),
  }));

  // If styles.css failed to load the page would still render, just unstyled --
  // which no functional test would notice.
  expect(r.inlineStyleTags).toBe(0);
  expect(r.tokenSet).toBe("#151827");
  expect(r.ground).toBe("rgb(21, 24, 39)");
});
