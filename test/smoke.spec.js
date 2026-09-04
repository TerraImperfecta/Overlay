// Does the page come up at all, and does capability probing produce a sane
// format list? PLAN.md section 5 item 3 wants the dropdown to *shrink* on a
// narrower browser rather than offer something that throws on use, so the
// assertions here are about shape, not about a fixed list of formats.

const { test, expect } = require("./fixtures");

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

  // MediaRecorder is not offered at all since #59. It survives only as the
  // repair for a coded mux that fails its own verification, which is not a
  // format and never reaches this list.
  expect(formats.filter((f) => f.recorder)).toEqual([]);

  // The selected default should be the best available, not merely the first.
  const selected = await page.evaluate(() => document.querySelector("#fmt").value);
  expect(selected).toBe(formats.some((f) => f.id === "webp") ? "webp" : "gif");
});

// The old version of this test matched `link[rel="icon"], link[rel=
// "apple-touch-icon"]`. The first of those is the static one in <head> and is
// always there, so the assertion held whether or not the rasteriser ran -- and
// it never ran, on any engine (#76). A test named for a thing must be able to
// fail when that thing is broken.
test("the icon rasterises into an apple-touch-icon", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page).toHaveTitle(/Overlay/);

  const link = page.locator('link[rel="apple-touch-icon"]');
  await expect(link).toHaveCount(1, { timeout: 5000 });

  const r = await page.evaluate(async () => {
    const el = document.querySelector('link[rel="apple-touch-icon"]');
    // A real PNG, not merely a link: decode it and check it is the size drawn.
    const bmp = await createImageBitmap(await (await fetch(el.href)).blob());
    return { href: el.href.slice(0, 22), w: bmp.width, h: bmp.height,
             fromStatic: el.href === document.querySelector('link[rel="icon"]').href };
  });

  expect(r.href).toBe("data:image/png;base64,");
  expect({ w: r.w, h: r.h }).toEqual({ w: 180, h: 180 });
  // It must be the rasterised PNG, not the static SVG copied across.
  expect(r.fromStatic).toBe(false);
});

test("a broken rasteriser costs the icon and nothing else", async ({ page }) => {
  // Section 0 is the first module main.js imports, and a module that throws
  // during evaluation fails the import that pulled it in -- so before #76 a
  // missing header or an objecting serialiser would have taken the whole app
  // down. Under the old <script> tags it would only have taken itself.
  await page.addInitScript(() => {
    XMLSerializer.prototype.serializeToString = () => { throw new Error("nope"); };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  const r = await page.evaluate(() => ({
    icon: document.querySelectorAll('link[rel="apple-touch-icon"]').length,
    formats: FORMATS.length,
    slots: document.querySelectorAll(".slot .lbl").length,
  }));

  expect(errors, `the page threw: ${errors.join(" | ")}`).toEqual([]);
  expect(r.icon).toBe(0);          // the icon is lost, as it must be
  expect(r.formats).toBeGreaterThan(0);   // and nothing else is
  expect(r.slots).toBe(2);
});

// --- the split into files (#75), now as modules (#78) ---------------------
//
// The tool was one file until #75, then fifteen ordered <script> tags, and is
// now a module graph behind a single entry. Each step changed what can go
// wrong. Tag order was the fragility #75 had to guard; imports settle that, so
// those tests are gone. What is left is a file the page asks for and does not
// get -- still silent, because a failed import breaks only what needed it.

test("every file the module graph pulls in is served", async ({ page }) => {
  const failed = [], js = new Set();
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (!r.ok()) failed.push(`${r.status()} ${path}`);
    if (path.endsWith(".js")) js.add(path);
  });

  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

  expect(failed).toEqual([]);
  // The entry plus every section it reaches, so a module orphaned from the
  // graph shows up as a file nobody fetched.
  expect(js.has("/js/main.js")).toBe(true);
  expect(js.size).toBeGreaterThanOrEqual(16);
});

test("the app keeps its names to itself", async ({ browser }) => {
  // A raw page, deliberately not the fixture's: the suite reaches the code by
  // pulling the module namespace onto globalThis after each navigation, and
  // that must stay a thing the tests do rather than a thing the app does.
  const page = await browser.newPage();
  try {
    await page.goto("/index.html");
    await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
    const leaked = await page.evaluate(() =>
      ["S", "geometry", "parseGIF", "exportGIF", "buildPalette", "planTimeline",
       "verifyBlob", "replan", "loadSource"].filter((n) => n in globalThis));
    expect(leaked).toEqual([]);
  } finally { await page.close(); }
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
