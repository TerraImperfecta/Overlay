// Positioning a layer without a pointer, and exactly (#61).
//
// Dragging on the preview used to be the only way to set place[i].x/y. A
// keyboard user could reach every other control -- the slot pickers take Enter
// and Space, the segmented controls are buttons, the sliders are sliders -- and
// then could not do the one thing the tool is for. Recenter was the only
// keyboard-reachable placement action, and it only resets.
//
// The units are the interesting decision. Placement is stored as the layer's
// centre, as a fraction of the base's natural size, because that is what
// survives swapping the base for one of a different size. Nobody thinks in
// those units, so the fields read the top-left corner in base pixels.
//
// Base pixels rather than output pixels, which sound more natural: in "Fit
// both" the canvas origin moves when the overlay does, so a typed 0 would not
// read back as 0. The last test here is that distinction.

const { test, expect } = require("@playwright/test");

const HELPERS = `
async function li(i, n){
  const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
  const src = await loadSource(new File([buf], n, {type:"image/gif"}), () => {});
  if (S.src[i]) disposeSource(i);
  S.src[i] = src; renderSlot(i);
}
async function two(){ await li(0,"05-subrect.gif"); await li(1,"01-interlaced.gif"); replan(); }
function frame(){
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}
function pos(i){ const p = layerPos(i); return {x: Math.round(p.x), y: Math.round(p.y)}; }
`;

async function open(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}
const load = (page) => page.evaluate(async (h) => { eval(h); await two(); await frame(); }, HELPERS);

// --- the keyboard path -----------------------------------------------------

test("arrow keys move the selected layer one pixel at a time", async ({ page }) => {
  await open(page); await load(page);
  await page.locator("#stage").focus();

  const before = await page.evaluate((h) => { eval(h); return pos(1); }, HELPERS);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const after = await page.evaluate((h) => { eval(h); return pos(1); }, HELPERS);

  expect(after.x - before.x).toBe(2);
  expect(after.y - before.y).toBe(1);
});

test("Shift makes the step ten", async ({ page }) => {
  await open(page); await load(page);
  await page.locator("#stage").focus();

  const before = await page.evaluate((h) => { eval(h); return pos(1); }, HELPERS);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowUp");
  const after = await page.evaluate((h) => { eval(h); return pos(1); }, HELPERS);

  expect(before.x - after.x).toBe(10);
  expect(before.y - after.y).toBe(10);
});

test("the arrows move the selected layer and leave the other alone",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      document.querySelector("#lyBase").click();     // select the base
      const base0 = pos(0), over0 = pos(1);
      const stage = document.querySelector("#stage");
      stage.focus();
      for (let i = 0; i < 3; i++)
        stage.dispatchEvent(new KeyboardEvent("keydown",
          { key:"ArrowRight", bubbles:true, cancelable:true }));
      await frame();
      return { base0, over0, base1: pos(0), over1: pos(1), sel: S.sel };
    }, HELPERS);

    expect(r.sel).toBe(0);
    expect(r.base1.x - r.base0.x).toBe(3);
    expect(r.over1).toEqual(r.over0);
  });

test("the arrows leave the page alone when there is nothing to move",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const stage = document.querySelector("#stage");
      const e = new KeyboardEvent("keydown", { key:"ArrowDown", bubbles:true, cancelable:true });
      stage.dispatchEvent(e);
      return { prevented: e.defaultPrevented };
    }, HELPERS);

    // Swallowing the key with no layer loaded would stop the page scrolling.
    expect(r.prevented).toBe(false);
  });

test("a modified arrow is left to the browser", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const stage = document.querySelector("#stage");
    const before = pos(1);
    for (const mod of ["metaKey","ctrlKey","altKey"]){
      stage.dispatchEvent(new KeyboardEvent("keydown",
        { key:"ArrowRight", bubbles:true, cancelable:true, [mod]: true }));
    }
    await frame();
    return { before, after: pos(1) };
  }, HELPERS);

  // Those are the browser's own shortcuts -- word jumps, history, scrolling.
  expect(r.after).toEqual(r.before);
});

// --- the numbers -----------------------------------------------------------

test("the fields read the layer's top-left corner in base pixels",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      await frame();
      return { field: { x: document.querySelector("#px").value,
                        y: document.querySelector("#py").value },
               model: pos(1),
               box: layerBox(1) };
    }, HELPERS);

    expect(r.field.x).toBe(String(r.model.x));
    expect(r.field.y).toBe(String(r.model.y));
    // The corner, not the centre that the model actually stores.
    expect(r.model.x).toBe(Math.round(r.box.x));
  });

test("a typed number puts the layer exactly there", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const px = document.querySelector("#px"), py = document.querySelector("#py");
    const set = (el, v) => { el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles:true })); };
    set(px, 7); set(py, -3);
    await frame();
    return { pos: pos(1), box: layerBox(1) };
  }, HELPERS);

  expect(r.pos).toEqual({ x: 7, y: -3 });
  expect(r.box.x).toBeCloseTo(7, 6);
  expect(r.box.y).toBeCloseTo(-3, 6);
});

test("an emptied field leaves the layer where it is", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const px = document.querySelector("#px");
    px.value = "12"; px.dispatchEvent(new Event("input", { bubbles:true }));
    await frame();
    const placed = pos(1);
    // Mid-edit: the field is briefly empty, and then briefly "-".
    px.focus();
    for (const v of ["", "-"]){
      px.value = v; px.dispatchEvent(new Event("input", { bubbles:true }));
    }
    await frame();
    return { placed, during: pos(1) };
  }, HELPERS);

  // Parsing "" as 0 would throw the layer to the corner while someone types.
  expect(r.during).toEqual(r.placed);
});

test("the fields follow every other way a layer moves", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const px = () => document.querySelector("#px").value;
    const stage = document.querySelector("#stage");

    stage.dispatchEvent(new PointerEvent("pointerdown",
      { bubbles:true, clientX:0, clientY:0, pointerId:1 }));
    stage.dispatchEvent(new PointerEvent("pointermove",
      { bubbles:true, clientX:60, clientY:0, pointerId:1 }));
    stage.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1 }));
    await frame();
    const afterDrag = px();

    document.querySelector("#center").click(); await frame();
    const afterCenter = px();

    // Scaling moves the corner even though the centre has not changed.
    const sc = document.querySelector("#sc");
    sc.value = "200"; sc.dispatchEvent(new Event("input", { bubbles:true }));
    await frame();
    const afterScale = px();

    document.querySelector("#lyBase").click(); await frame();
    return { afterDrag, afterCenter, afterScale, afterSwitch: px(),
             baseX: pos(0).x };
  }, HELPERS);

  expect(r.afterDrag).not.toBe(r.afterCenter);
  expect(r.afterScale).not.toBe(r.afterCenter);
  // Switching layers has to show the layer the fields now edit.
  expect(r.afterSwitch).toBe(String(r.baseX));
});

test("the fields update because the layer moved, not because a frame was drawn",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const px = document.querySelector("#px");
      const before = px.value;
      const stage = document.querySelector("#stage");
      stage.dispatchEvent(new KeyboardEvent("keydown",
        { key:"ArrowRight", bubbles:true, cancelable:true }));
      /* Read synchronously: no await, so no frame has been drawn yet. */
      return { before, immediately: px.value, model: pos(1).x };
    }, HELPERS);

    // requestAnimationFrame does not run in a background tab and is throttled
    // well below the rate a held key repeats, so a field refreshed only by the
    // loop shows a stale number for as long as that lasts.
    expect(r.immediately).not.toBe(r.before);
    expect(r.immediately).toBe(String(r.model));
  });

test("the fields do not rewrite what is being typed", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const px = document.querySelector("#px");
    px.focus();
    px.value = "1";           // half of "18", not yet committed
    await frame(); await frame();
    return { still: px.value, focused: document.activeElement === px };
  }, HELPERS);

  // The loop refreshes these every frame; without the focus guard it would
  // overwrite the first digit before the second could be typed.
  expect(r.focused).toBe(true);
  expect(r.still).toBe("1");
});

test("the fields are disabled until there is a layer to place", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector("#px").disabled;
  });
  await load(page);
  const after = await page.evaluate(() => document.querySelector("#px").disabled);

  expect(before).toBe(true);
  expect(after).toBe(false);
});

// --- why base pixels -------------------------------------------------------

test("with the default base placement, base pixels are output pixels",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const g = geometry(), b = layerBox(1);
      return { field: +document.querySelector("#px").value,
               inOutput: Math.round(b.x + g.dx), dx: g.dx };
    }, HELPERS);

    expect(r.dx).toBe(0);
    expect(r.field).toBe(r.inOutput);
  });

test("a typed coordinate reads back as typed, even in Fit both",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      document.querySelector("#cvFit").click();
      const px = document.querySelector("#px");
      px.value = "-20"; px.dispatchEvent(new Event("input", { bubbles:true }));
      await frame();
      const g = geometry();
      return { field: px.value, model: pos(1).x, dx: g.dx,
               inOutput: Math.round(layerBox(1).x + g.dx) };
    }, HELPERS);

    // Pushing the overlay left of the base grows the canvas leftwards, so the
    // same layer is now at a different *output* coordinate. Had the fields been
    // in output pixels, typing -20 would have read back as 0 -- which is the
    // whole reason they are not.
    expect(r.dx).toBeGreaterThan(0);
    expect(r.inOutput).not.toBe(-20);
    expect(r.field).toBe("-20");
    expect(r.model).toBe(-20);
  });

// --- the canvas as a control ----------------------------------------------

test("the preview can be reached and says what it is", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const stage = document.querySelector("#stage");
    stage.focus();
    return { tabindex: stage.getAttribute("tabindex"),
             focused: document.activeElement === stage,
             label: stage.getAttribute("aria-label"),
             help: document.getElementById(stage.getAttribute("aria-describedby")).textContent };
  }, HELPERS);

  expect(r.tabindex).toBe("0");
  expect(r.focused).toBe(true);
  // It used to be an unlabelled canvas: a blank to anyone not looking at it.
  expect(r.label).toContain("01-interlaced.gif");
  expect(r.label).toContain("05-subrect.gif");
  expect(r.help).toMatch(/arrow keys/i);
});

test("the description tracks what is actually loaded", async ({ page }) => {
  await open(page);
  const label = () => page.evaluate(() =>
    document.querySelector("#stage").getAttribute("aria-label"));

  const empty = await label();
  await page.evaluate(async (h) => { eval(h); await li(0,"05-subrect.gif"); replan(); }, HELPERS);
  const one = await label();
  await load(page);
  const both = await label();

  expect(empty).toMatch(/nothing loaded/i);
  expect(one).toMatch(/waiting for a second file/i);
  expect(both).toMatch(/over/);
});

test("moving a layer is announced", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const live = document.querySelector("#announce");
    const stage = document.querySelector("#stage");
    const atStart = live.textContent;
    stage.dispatchEvent(new KeyboardEvent("keydown",
      { key:"ArrowRight", bubbles:true, cancelable:true }));
    await frame();
    const afterNudge = live.textContent;
    document.querySelector("#center").click(); await frame();
    return { atStart, afterNudge, afterCenter: live.textContent,
             role: live.getAttribute("role"), live: live.getAttribute("aria-live") };
  }, HELPERS);

  expect(r.atStart).toBe("");
  expect(r.afterNudge).toMatch(/^Overlay at -?\d+, -?\d+$/);
  // Recenter was the one placement action a keyboard could already reach, and
  // it said nothing about what it had done.
  expect(r.afterCenter).not.toBe(r.afterNudge);
  expect(r.live).toBe("polite");
});
