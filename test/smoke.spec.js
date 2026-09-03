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
