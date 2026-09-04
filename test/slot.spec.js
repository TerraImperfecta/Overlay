// Reloading a slot: one thumbnail, nothing leaked, and a bad file must not
// destroy the source you already had (#26).
//
// Three invariants from PLAN.md section 3 meet here, and each was a bug once:
//
//   renderSlot(i) rebuilds the slot from state. The original patched innerHTML
//   in place, which appended a second thumbnail on every reload and leaked the
//   object URLs behind the old ones.
//
//   disposeSource(i) runs only after the new source decodes. Disposing first
//   means a file that fails to read destroys the working one it replaced.
//
//   Frames are ImageBitmap, not ImageData, because raw arrays cost hundreds of
//   megabytes on a video. disposeSource has to close every one of them.
//
// Everything here goes through the drop handler rather than calling accept()
// directly. #24 is the reason: a test aimed one layer below the bug asserted on
// a value the user never sees, and passed while the feature was broken.

const { test, expect } = require("@playwright/test");

// Drop a corpus file on a slot exactly as a user would, and wait for the load
// to settle.
const HELPERS = `
async function drop(i, name, mime){
  const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
  const file = new File([buf], name, {type: mime || "image/gif"});
  const dt = new DataTransfer();
  dt.items.add(file);
  const slot = document.querySelector('.slot[data-i="' + i + '"]');
  slot.dispatchEvent(new DragEvent("drop", {dataTransfer: dt, bubbles: true, cancelable: true}));
  await settle(i);
  return file;
}

async function dropFile(i, file){
  const dt = new DataTransfer();
  dt.items.add(file);
  const slot = document.querySelector('.slot[data-i="' + i + '"]');
  slot.dispatchEvent(new DragEvent("drop", {dataTransfer: dt, bubbles: true, cancelable: true}));
  await settle(i);
}

// accept() is async and sets loading[i] for its duration; wait for the slot to
// stop saying "Decoding" and for the source to change or an error to appear.
async function settle(i){
  const t0 = performance.now();
  while (performance.now() - t0 < 15000){
    await new Promise(r => setTimeout(r, 20));
    const slot = document.querySelector('.slot[data-i="' + i + '"]');
    const meta = slot.querySelector(".meta");
    if (!meta || !/Decoding/.test(meta.textContent)) return;
  }
  throw new Error("slot never settled");
}

function slotState(i){
  const slot = document.querySelector('.slot[data-i="' + i + '"]');
  return {
    thumbs: slot.querySelectorAll(".thumb").length,
    name: slot.querySelector(".name") ? slot.querySelector(".name").textContent : null,
    meta: slot.querySelector(".meta") ? slot.querySelector(".meta").textContent : "",
    isError: !!slot.querySelector(".meta.warn"),
  };
}
`;

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
});

test("three files in succession leave exactly one thumbnail each time",
  async ({ page }) => {
    const rows = await page.evaluate(async (helpers) => {
      eval(helpers);
      const out = [];
      for (const name of ["05-subrect.gif", "01-interlaced.gif", "03-disposal-3.gif"]) {
        await drop(0, name);
        out.push({ ...slotState(0), src: S.src[0].name });
      }
      return out;
    }, HELPERS);

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // Two thumbnails is the exact symptom of patching innerHTML rather than
      // rebuilding the slot.
      expect(r.thumbs, `${r.src} left ${r.thumbs} thumbnails`).toBe(1);
      expect(r.isError).toBe(false);
    }
    // And the readout tracked each one rather than going stale.
    expect(rows.map((r) => r.src)).toEqual(
      ["05-subrect.gif", "01-interlaced.gif", "03-disposal-3.gif"]);
    expect(rows.map((r) => r.name)).toEqual(
      ["05-subrect.gif", "01-interlaced.gif", "03-disposal-3.gif"]);
    expect(new Set(rows.map((r) => r.meta)).size).toBeGreaterThan(1);
  });

test("replacing a source closes its bitmaps and revokes its thumbnail URL",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      await drop(0, "05-subrect.gif");
      const old = S.src[0];
      const oldBitmaps = old.frames.map((f) => f.bitmap);
      const oldThumb = old.thumb;
      // A live ImageBitmap reports its real size; a closed one reports 0.
      const openBefore = oldBitmaps.filter((b) => b.width > 0).length;

      await drop(0, "01-interlaced.gif");

      let thumbStillFetchable = true;
      try { await fetch(oldThumb); } catch { thumbStillFetchable = false; }

      return {
        replaced: S.src[0] !== old,
        openBefore, count: oldBitmaps.length,
        openAfter: oldBitmaps.filter((b) => b.width > 0).length,
        thumbWasBlobUrl: /^blob:/.test(oldThumb),
        thumbStillFetchable,
      };
    }, HELPERS);

    expect(r.replaced).toBe(true);
    expect(r.openBefore).toBe(r.count);
    // Every frame's bitmap closed, not merely dereferenced -- an ImageBitmap
    // holds GPU memory that dropping the reference does not release promptly.
    expect(r.openAfter, `${r.openAfter} of ${r.count} bitmaps still open`).toBe(0);
    expect(r.thumbWasBlobUrl).toBe(true);
    expect(r.thumbStillFetchable, "the old thumbnail URL was never revoked").toBe(false);
  });

test("repeated reloads leave only the current source's bitmaps open",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      const names = ["05-subrect.gif", "01-interlaced.gif", "03-disposal-3.gif",
                     "08-first-frame-partial.gif"];
      const everCreated = [];
      for (let round = 0; round < 8; round++) {
        await drop(0, names[round % names.length]);
        everCreated.push(...S.src[0].frames.map((f) => f.bitmap));
      }
      const current = new Set(S.src[0].frames.map((f) => f.bitmap));
      const open = everCreated.filter((b) => b.width > 0);
      return {
        rounds: 8, created: everCreated.length, open: open.length,
        currentCount: current.size,
        allOpenAreCurrent: open.every((b) => current.has(b)),
        heapMB: performance.memory
          ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      };
    }, HELPERS);

    // A deterministic stand-in for "memory does not grow": after eight reloads
    // the only bitmaps still holding memory belong to the source on screen.
    // Heap size itself is too noisy to assert on, so it is only reported.
    expect(r.created).toBeGreaterThan(r.currentCount);
    expect(r.open).toBe(r.currentCount);
    expect(r.allOpenAreCurrent).toBe(true);
  });

test("a file that cannot be decoded leaves the previous source intact",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      await drop(0, "05-subrect.gif");
      const good = S.src[0];
      const goodBitmaps = good.frames.map((f) => f.bitmap);

      const junk = new File([new Uint8Array([1, 2, 3, 4, 5])], "notes.txt",
                            { type: "text/plain" });
      await dropFile(0, junk);

      return {
        state: slotState(0),
        sameSource: S.src[0] === good,
        stillOpen: goodBitmaps.every((b) => b.width > 0),
        name: S.src[0] ? S.src[0].name : null,
      };
    }, HELPERS);

    // disposeSource runs only after the replacement decodes, so a bad file
    // costs the user nothing.
    expect(r.sameSource, "the working source was replaced or dropped").toBe(true);
    expect(r.stillOpen, "the surviving source's bitmaps were closed anyway").toBe(true);
    expect(r.name).toBe("05-subrect.gif");
    expect(r.state.isError).toBe(true);
    expect(r.state.thumbs).toBe(1);
  });

test("dropping the same file twice is handled", async ({ page }) => {
  const r = await page.evaluate(async (helpers) => {
    eval(helpers);
    const file = await drop(0, "05-subrect.gif");
    const first = S.src[0];
    await dropFile(0, file);                 // the very same File object
    return { ...slotState(0), replaced: S.src[0] !== first,
             stillLoaded: !!S.src[0], name: S.src[0] && S.src[0].name };
  }, HELPERS);

  // The related invariant -- input.value = "" before input.click(), so re-picking
  // the same file still fires a change event -- cannot be reached from a test,
  // because the file dialog is not scriptable. This covers the drop path, where
  // the same File arriving twice must simply work.
  expect(r.thumbs).toBe(1);
  expect(r.isError).toBe(false);
  expect(r.replaced).toBe(true);
  expect(r.name).toBe("05-subrect.gif");
});

test("the file input is cleared before the picker opens", async ({ page }) => {
  // Reading input.value here would prove nothing: a file input reads as "" until
  // a file has been picked, and the picker cannot be driven from a test. So this
  // watches for the assignment itself, which is the line that has to survive.
  //
  // Without it, re-picking the same file fires no change event and the UI
  // simply appears frozen -- PLAN.md section 3.
  const r = await page.evaluate(() => {
    const input = document.querySelector("#file0");
    let clearedBeforeClick = false, clicked = false, assignments = 0;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: (v) => { assignments++; if (v === "") clearedBeforeClick = !clicked; },
    });
    const realClick = input.click.bind(input);
    input.click = () => { clicked = true; };
    try {
      document.querySelector('.slot[data-i="0"]').dispatchEvent(
        new MouseEvent("click", { bubbles: true }));
    } finally {
      delete input.value;
      input.click = realClick;
    }
    return { clicked, assignments, clearedBeforeClick };
  });

  expect(r.clicked, "the slot click never reached input.click()").toBe(true);
  expect(r.assignments, "input.value was never assigned").toBeGreaterThan(0);
  expect(r.clearedBeforeClick, "input.value was not cleared before the click").toBe(true);
});
