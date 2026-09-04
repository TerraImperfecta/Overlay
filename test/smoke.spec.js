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
