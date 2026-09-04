// Persisted settings (#32).
//
// The happy path is the least interesting part. What matters is that a stored
// preference can never stop the app starting: the value may be absent, corrupt,
// out of range, from an older version, hand-edited, or name a format this
// browser cannot produce -- and on some browsers merely *touching* localStorage
// throws rather than returning null.
//
// Nothing derived from a loaded file is stored. Not the sources, and not layer
// placement, whose coordinates are fractions of a base that will not be there.

const { test, expect } = require("./fixtures");

const KEY = "overlay.settings.v1";

async function open(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}

async function readState(page) {
  return page.evaluate(() => ({
    quality: S.quality, outScale: S.outScale, opacity: S.opacity,
    sync: S.sync, bg: S.bg, bgColor: S.bgColor,
    format: document.querySelector("#fmt").value,
    options: [...document.querySelector("#fmt").options].map((o) => o.value),
    q: document.querySelector("#q").value,
    osc: document.querySelector("#osc").value,
    op: document.querySelector("#op").value,
    bgPressed: document.querySelector("#bgC").getAttribute("aria-pressed"),
  }));
}

test("settings survive a reload, controls included", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const fire = (id, value, ev) => {
      const el = document.querySelector(id);
      el.value = String(value);
      el.dispatchEvent(new Event(ev, { bubbles: true }));
    };
    fire("#q", 40, "input");
    fire("#osc", 55, "input");
    fire("#op", 30, "input");
    fire("#sync", "stretch", "change");
    document.querySelector("#bgC").click();
    fire("#bgColor", "#123456", "input");
    const fmt = document.querySelector("#fmt");
    fmt.value = "gif";
    fmt.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await open(page);
  const s = await readState(page);

  expect(s.quality).toBeCloseTo(0.4, 6);
  expect(s.outScale).toBeCloseTo(0.55, 6);
  expect(s.opacity).toBeCloseTo(0.3, 6);
  expect(s.sync).toBe("stretch");
  expect(s.bg).toBe("solid");
  expect(s.bgColor).toBe("#123456");
  expect(s.format).toBe("gif");

  // The controls have to show the restored values, not the defaults, or the
  // panel and the state disagree until the user touches something.
  expect(s.q).toBe("40");
  expect(s.osc).toBe("55");
  expect(s.op).toBe("30");
  expect(s.bgPressed).toBe("true");
});

test("a first visit uses the defaults and stores nothing", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => ({
    stored: localStorage.getItem("overlay.settings.v1"),
    quality: S.quality, outScale: S.outScale, opacity: S.opacity, bg: S.bg,
  }));
  // Reading settings must not write them: an untouched visit leaves no trace.
  expect(r.stored).toBeNull();
  expect(r.quality).toBeCloseTo(0.82, 6);
  expect(r.outScale).toBe(1);
  expect(r.opacity).toBe(1);
  expect(r.bg).toBe("transparent");
});

test("corrupt stored data is ignored, not fatal", async ({ page }) => {
  for (const junk of ["not json at all", "null", "[]", '"a string"', "{", "123"]) {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, junk]);
    const errors = [];
    page.once("pageerror", (e) => errors.push(e.message));
    await open(page);
    const s = await readState(page);
    expect(errors, `${junk} threw: ${errors.join()}`).toEqual([]);
    expect(s.quality, `${junk} changed quality`).toBeCloseTo(0.82, 6);
    // Not merely non-empty: a stale or invented id would leave the control
    // showing a value the browser cannot produce.
    expect(s.options).toContain(s.format);
  }
});

test("one bad field costs that field, not the rest", async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({
    quality: "loads",            // wrong type
    outScale: 99,                // out of range
    opacity: 0.25,               // fine
    sync: "sideways",            // not an option
    bg: "solid",                 // fine
    bgColor: "red",              // not a hex triple
  })]);
  await open(page);
  const s = await readState(page);

  // Validated one at a time, so the two good values survive their neighbours.
  expect(s.opacity).toBeCloseTo(0.25, 6);
  expect(s.bg).toBe("solid");
  expect(s.quality).toBeCloseTo(0.82, 6);
  expect(s.outScale).toBe(1);
  expect(s.sync).toBe("auto");
  expect(s.bgColor).toBe("#000000");
});

test("a format this browser cannot produce falls back instead of vanishing",
  async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY,
      JSON.stringify({ format: "mp4-h265-imaginary" })]);
    await open(page);
    const r = await page.evaluate(() => {
      const sel = document.querySelector("#fmt");
      return { value: sel.value, options: [...sel.options].map((o) => o.value),
               note: document.querySelector("#fmtNote").textContent };
    });

    // Selecting a missing option would leave the control blank and the note
    // stale; buildFormats' own choice has to win.
    expect(r.options).toContain(r.value);
    expect(r.value).not.toBe("mp4-h265-imaginary");
    expect(r.note.length).toBeGreaterThan(0);
  });

test("the app starts even when touching localStorage throws", async ({ page }) => {
  // Some browsers, notably in private windows, throw on access rather than
  // returning null. Every read and write is wrapped for exactly this.
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
    });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await open(page);
  const r = await page.evaluate(() => {
    const el = document.querySelector("#op");
    el.value = "45";
    el.dispatchEvent(new Event("input", { bubbles: true }));   // must not throw
    return { opacity: S.opacity, formats: FORMATS.length,
             fmt: document.querySelector("#fmt").value,
             options: [...document.querySelector("#fmt").options].map((o) => o.value) };
  });

  expect(errors, `startup threw: ${errors.join(" | ")}`).toEqual([]);
  expect(r.formats).toBeGreaterThan(0);
  expect(r.options).toContain(r.fmt);
  // And the controls still work; they simply do not persist.
  expect(r.opacity).toBeCloseTo(0.45, 6);
});

test("nothing derived from a loaded file is stored", async ({ page }) => {
  await open(page);
  const stored = await page.evaluate(async () => {
    async function li(i, n) {
      const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
      const src = await loadSource(new File([buf], n, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await li(0, "05-subrect.gif");
    await li(1, "01-interlaced.gif");
    S.place[0] = { scale: 2, x: 0.1, y: 0.9 };
    S.sel = 0;
    replan();
    // Touch a persisted control so a write definitely happens.
    const el = document.querySelector("#op");
    el.value = "60";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return localStorage.getItem("overlay.settings.v1");
  });

  const parsed = JSON.parse(stored);
  // Placement is expressed as fractions of a base that will not be loaded next
  // time, so restoring it would move layers to meaningless positions.
  expect(Object.keys(parsed).sort()).toEqual(
    ["bg", "bgColor", "format", "opacity", "outScale", "quality", "sync"]);
  expect(stored).not.toContain("place");
  expect(stored).not.toContain("05-subrect");
});

test("restoring does not leave the plan stale", async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY,
    JSON.stringify({ outScale: 0.5, sync: "shortest" })]);
  await open(page);
  const r = await page.evaluate(async () => {
    async function li(i, n) {
      const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
      const src = await loadSource(new File([buf], n, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await li(0, "05-subrect.gif");
    await li(1, "06-delay-zero.gif");
    replan();
    return { mode: S.plan.mode, dims: document.querySelector("#dims").textContent };
  });

  // The restored sync mode has to be the one the plan was built with, and the
  // dimensions readout has to reflect the restored output scale.
  expect(r.mode).toBe("shortest");
  expect(r.dims).toBe("16×16");
});
