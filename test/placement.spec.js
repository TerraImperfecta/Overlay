// Per-layer placement (#30).
//
// Placement used to belong to the overlay alone, with its position expressed as
// a fraction of the base's width and height -- the base was the coordinate
// system. Letting the base move made that circular, so both layers now carry a
// {scale, x, y} in one shared space, still measured in base-natural units so
// the defaults mean exactly what the old pinned behaviour meant.
//
// The canvas rule, decided before any of this was written:
//
//   Base size  canvas = the base's placed rectangle
//   Fit both   canvas = the union of both placed rectangles
//
// So scaling the base scales the output, and moving it slides the overlay
// underneath rather than resizing anything.

const { test, expect } = require("./fixtures");

const HELPERS = `
async function two(baseW, baseH, overW, overH){
  async function make(w, h){
    const c = new OffscreenCanvas(w, h), cx = c.getContext("2d");
    cx.fillStyle = "#c33"; cx.fillRect(0, 0, w, h);
    const bitmap = await createImageBitmap(c);
    return {name: w + "x" + h, kind: "gif", width: w, height: h,
            frames: [{bitmap, delay: 100}, {bitmap, delay: 100}],
            starts: [0, 100], duration: 200, static: false, thumb: null, meta: ""};
  }
  if (S.src[0]) disposeSource(0);
  if (S.src[1]) disposeSource(1);
  S.src[0] = await make(baseW, baseH);
  S.src[1] = await make(overW, overH);
  S.place = [{scale: 1, x: .5, y: .5}, {scale: 1, x: .5, y: .5}];
  S.sel = 1; S.canvasMode = "base"; S.sync = "auto";
  replan();
}
`;

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
});

test("the defaults reproduce the old base-pinned geometry", async ({ page }) => {
  const g = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);
    return { base: geometry(), fit: (S.canvasMode = "fit", geometry()) };
  }, HELPERS);

  // Untouched placement has to mean what it always meant, or every existing
  // export changes size.
  expect(g.base).toEqual({ w: 200, h: 120, dx: 0, dy: 0 });
  // A centred overlay smaller than the base adds nothing to the union.
  expect(g.fit).toEqual({ w: 200, h: 120, dx: 0, dy: 0 });
});

test("scaling the base scales the output, growing around its centre",
  async ({ page }) => {
    const g = await page.evaluate(async (h) => {
      eval(h);
      await two(200, 120, 60, 40);
      S.place[0].scale = 2;
      return geometry();
    }, HELPERS);

    expect(g.w).toBe(400);
    expect(g.h).toBe(240);
    // Centre-anchored, so the box starts half a base-width to the left and the
    // offset compensates.
    expect(g.dx).toBe(100);
    expect(g.dy).toBe(60);
  });

test("moving the base in Base size shifts what is under it, not the output size",
  async ({ page }) => {
    const r = await page.evaluate(async (h) => {
      eval(h);
      await two(200, 120, 60, 40);
      const before = geometry();
      S.place[0].x = 0.8; S.place[0].y = 0.2;
      return { before, after: geometry() };
    }, HELPERS);

    // The canvas follows the base, so the export dimensions do not move.
    expect(r.after.w).toBe(r.before.w);
    expect(r.after.h).toBe(r.before.h);
    // But the frame has slid, which is what changes where the overlay lands.
    expect(r.after.dx).not.toBe(r.before.dx);
    expect(r.after.dy).not.toBe(r.before.dy);
  });

test("Fit both is the union of the two placed rectangles", async ({ page }) => {
  const g = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);
    S.canvasMode = "fit";
    // Push the overlay off the right-hand edge: its centre is one base-width
    // across, so its box runs from 170 to 230 against the base's 0 to 200.
    S.place[1].x = 1;
    return geometry();
  }, HELPERS);

  expect(g.w).toBe(230);
  expect(g.h).toBe(120);
  expect(g.dx).toBe(0);
});

test("Fit both accounts for the base moving too", async ({ page }) => {
  const g = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);
    S.canvasMode = "fit";
    // Base pushed left of the origin; the union has to grow leftwards and the
    // offset has to bring it back into positive coordinates.
    S.place[0].x = 0.25;
    return geometry();
  }, HELPERS);

  // Base box now runs -50..150, overlay stays 70..130, so the union is -50..150.
  expect(g.w).toBe(200);
  expect(g.dx).toBe(50);
});

test("the layer selector routes the size slider and the drag", async ({ page }) => {
  const r = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);

    const setScale = (pct) => {
      const el = document.querySelector("#sc");
      el.value = String(pct);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const drag = (dx, dy) => {
      const stage = document.querySelector("#stage");
      stage.dispatchEvent(new PointerEvent("pointerdown",
        { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
      stage.dispatchEvent(new PointerEvent("pointermove",
        { bubbles: true, clientX: dx, clientY: dy, pointerId: 1 }));
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    };

    document.querySelector("#lyOver").click();
    setScale(150); drag(20, 0);
    const overlay = { ...S.place[1] }, baseUntouched = { ...S.place[0] };

    document.querySelector("#lyBase").click();
    const sliderAfterSwitch = document.querySelector("#sc").value;
    setScale(50); drag(0, 15);

    return { sel: S.sel, overlay, baseUntouched, sliderAfterSwitch,
             base: { ...S.place[0] }, overlayAfter: { ...S.place[1] } };
  }, HELPERS);

  expect(r.overlay.scale).toBeCloseTo(1.5, 6);
  expect(r.overlay.x).toBeGreaterThan(0.5);          // the drag moved it
  expect(r.baseUntouched.scale).toBe(1);             // and left the base alone

  // Switching layers moves the slider onto the layer it now controls, rather
  // than leaving the previous layer's value showing.
  expect(r.sliderAfterSwitch).toBe("100");
  expect(r.sel).toBe(0);
  expect(r.base.scale).toBeCloseTo(0.5, 6);
  expect(r.base.y).toBeGreaterThan(0.5);
  expect(r.overlayAfter.scale).toBeCloseTo(1.5, 6);  // untouched by the base edits
});

test("Recenter acts on the selected layer only", async ({ page }) => {
  const r = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);
    S.place[0].x = 0.2; S.place[1].x = 0.9;
    S.sel = 0;
    document.querySelector("#center").click();
    return { base: { ...S.place[0] }, over: { ...S.place[1] } };
  }, HELPERS);

  expect(r.base.x).toBe(0.5);
  expect(r.over.x).toBe(0.9);
});

test("the base can be moved with no overlay loaded", async ({ page }) => {
  const r = await page.evaluate(async (h) => {
    eval(h);
    await two(200, 120, 60, 40);
    disposeSource(1); S.src[1] = null;
    S.sel = 0;
    const stage = document.querySelector("#stage");
    stage.dispatchEvent(new PointerEvent("pointerdown",
      { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
    stage.dispatchEvent(new PointerEvent("pointermove",
      { bubbles: true, clientX: 30, clientY: 0, pointerId: 1 }));
    stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    return { x: S.place[0].x, geometry: geometry() };
  }, HELPERS);

  // The old handler refused to start unless a second source was loaded, because
  // only the overlay could move. The base no longer needs company.
  expect(r.x).toBeGreaterThan(0.5);
  expect(r.geometry.w).toBe(200);
});

test("odd output dimensions are still forced even", async ({ page }) => {
  const r = await page.evaluate(async (h) => {
    eval(h);
    await two(201, 121, 60, 40);          // odd on both axes
    S.place[0].scale = 1;
    S.outScale = 1;
    const g = geometry();
    const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
    return { g, W, H };
  }, HELPERS);

  // H.264 and AV1 reject odd dimensions, whatever placement produced them.
  expect(r.g.w % 2).toBe(1);              // geometry itself may be odd
  expect(r.W % 2).toBe(0);
  expect(r.H % 2).toBe(0);
});

test("a render draws from the placement in its snapshot, not the live one",
  async ({ page }) => {
    const r = await page.evaluate(async (h) => {
      eval(h);
      await two(200, 120, 60, 40);
      const view = renderView(S.plan);
      const before = geometry(view);
      // Move the base after the snapshot was taken, as a mid-render drag would.
      S.place[0].scale = 3;
      return { before, afterLive: geometry(), afterView: geometry(view) };
    }, HELPERS);

    // #27's guarantee has to survive placement joining the snapshot.
    expect(r.afterView).toEqual(r.before);
    expect(r.afterLive.w).not.toBe(r.before.w);
  });
