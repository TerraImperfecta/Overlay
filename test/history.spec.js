// Undo and redo for placement (#62).
//
// A drag used to overwrite the previous position with no way back, and
// "Recenter layer" reset to the middle rather than returning to where you were.
// That was tolerable while dragging was the only way to move a layer and every
// drag was small. It stopped being tolerable once positions could also be typed
// and nudged (#61): a mistyped number can throw a layer somewhere unrecoverable.
//
// The property that matters most here is coalescing. A history that records one
// entry per pointermove is worse than no history at all -- undo appears not to
// work, because the first fifty presses move the layer by a pixel each.
//
// Scope is placement only, on purpose. Format, quality, sync mode and the rest
// are single controls whose previous value is visible in the control itself and
// which persist between visits, so a general stack would be a much larger
// commitment for much less benefit.

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
function press(key, opts){
  document.querySelector("#stage").dispatchEvent(
    new KeyboardEvent("keydown", {key, bubbles:true, cancelable:true, ...(opts||{})}));
}
function drag(dx, dy){
  const stage = document.querySelector("#stage");
  stage.dispatchEvent(new PointerEvent("pointerdown",
    { bubbles:true, clientX:0, clientY:0, pointerId:1 }));
  for (let i = 1; i <= 12; i++)
    stage.dispatchEvent(new PointerEvent("pointermove",
      { bubbles:true, clientX:dx*i/12, clientY:dy*i/12, pointerId:1 }));
  stage.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1 }));
}
`;

async function open(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}
const load = (page) => page.evaluate(async (h) => { eval(h); await two(); await frame(); }, HELPERS);

// --- coalescing ------------------------------------------------------------

test("a whole drag is one step, however many moves it took", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const start = pos(1);
    drag(80, 40);
    const dragged = pos(1);
    const steps = past.length;
    undo();
    return { start, dragged, steps, afterUndo: pos(1) };
  }, HELPERS);

  expect(r.dragged).not.toEqual(r.start);
  // Twelve pointermove events; one entry.
  expect(r.steps).toBe(1);
  expect(r.afterUndo).toEqual(r.start);
});

test("a drag is recorded even when pointer capture is refused", async ({ page }) => {
  // setPointerCapture throws on a pointer id the browser does not recognise, and
  // it used to run before beginChange in the same handler -- so the throw cost
  // the drag its history entry while the drag itself carried on working, which
  // is the most confusing shape this bug could take. Firefox found it.
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const stage = document.querySelector("#stage");
    let asked = false;
    stage.setPointerCapture = () => { asked = true;
      throw new DOMException("Invalid pointer id.", "NotFoundError"); };
    const start = pos(1);
    drag(70, 0);
    const moved = pos(1);
    undo();
    return { asked, start, moved, back: pos(1) };
  }, HELPERS);

  expect(r.asked).toBe(true);
  // Capture is a convenience; the drag and its history must not depend on it.
  expect(r.moved).not.toEqual(r.start);
  expect(r.back).toEqual(r.start);
});

test("a held arrow key is one step, and deliberate presses are their own",
  async ({ page }) => {
    await open(page); await load(page);
    const rapid = await page.evaluate(async (h) => {
      eval(h);
      const start = pos(1);
      for (let i = 0; i < 6; i++) press("ArrowRight");
      const moved = pos(1);
      undo();
      return { start, moved, back: pos(1) };
    }, HELPERS);

    expect(rapid.moved.x - rapid.start.x).toBe(6);
    expect(rapid.back).toEqual(rapid.start);

    // Past the coalescing window, a second press is a second step.
    const spaced = await page.evaluate(async (h) => {
      eval(h);
      const start = pos(1);
      press("ArrowRight");
      await new Promise(r => setTimeout(r, 800));
      press("ArrowRight");
      const moved = pos(1);
      undo();
      const once = pos(1);
      undo();
      return { start, moved, once, twice: pos(1) };
    }, HELPERS);

    expect(spaced.moved.x - spaced.start.x).toBe(2);
    expect(spaced.once.x - spaced.start.x).toBe(1);
    expect(spaced.twice).toEqual(spaced.start);
  });

test("the digits of one typed number are one step", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const start = pos(1);
    const px = document.querySelector("#px");
    px.focus();
    for (const v of ["1", "12", "123"]){          // as the keystrokes arrive
      px.value = v; px.dispatchEvent(new Event("input", { bubbles:true }));
    }
    px.dispatchEvent(new Event("change", { bubbles:true }));
    const typed = pos(1), steps = past.length;
    undo();
    return { start, typed, steps, back: pos(1) };
  }, HELPERS);

  expect(r.typed.x).toBe(123);
  expect(r.steps).toBe(1);
  // The point of the issue: a mistyped number is recoverable.
  expect(r.back).toEqual(r.start);
});

test("a drag that never moved is not a step", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const stage = document.querySelector("#stage");
    stage.dispatchEvent(new PointerEvent("pointerdown",
      { bubbles:true, clientX:5, clientY:5, pointerId:1 }));
    stage.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1 }));
    // And a field re-typed to the number it already held.
    const px = document.querySelector("#px");
    const was = px.value;
    px.value = was; px.dispatchEvent(new Event("input", { bubbles:true }));
    px.dispatchEvent(new Event("change", { bubbles:true }));
    return { steps: past.length, undoDisabled: document.querySelector("#undo").disabled };
  }, HELPERS);

  // Either would otherwise cost an undo press that does nothing visible.
  expect(r.steps).toBe(0);
  expect(r.undoDisabled).toBe(true);
});

// --- the stack -------------------------------------------------------------

test("redo reapplies, and a new change discards the redone future",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const start = pos(1);
      drag(60, 0);
      const moved = pos(1);
      undo();
      const undone = pos(1), canRedo = !document.querySelector("#redo").disabled;
      redo();
      const redone = pos(1);

      undo();                       // back to start, with `moved` in the future
      drag(0, 45);                  // a new branch
      return { start, moved, undone, canRedo, redone,
               futureAfterNewChange: future.length,
               redoDisabled: document.querySelector("#redo").disabled };
    }, HELPERS);

    expect(r.undone).toEqual(r.start);
    expect(r.canRedo).toBe(true);
    expect(r.redone).toEqual(r.moved);
    // Redoing into a branch that no longer exists would restore a position the
    // user never asked for.
    expect(r.futureAfterNewChange).toBe(0);
    expect(r.redoDisabled).toBe(true);
  });

test("the history is bounded", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    for (let i = 0; i < HISTORY_MAX + 20; i++){
      beginChange("k" + i);                 // a distinct gesture each time
      S.place[1].x += 0.001;
      endChange();
    }
    const depth = past.length;
    // The oldest entries are the ones dropped, so undo still walks backwards.
    // Compared raw: a thousandth of the base's width does not survive rounding
    // to whole pixels, which is all layerPos reports.
    const before = S.place[1].x;
    undo();
    return { depth, undone: S.place[1].x, before };
  }, HELPERS);

  expect(r.depth).toBe(50);
  expect(r.undone).toBeLessThan(r.before);
  expect(r.undone).toBeCloseTo(r.before - 0.001, 9);
});

test("undo works straight after a drag, with nothing in between",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const start = pos(1);
      drag(50, 0);
      // No blur, no other gesture: the open gesture has to be closed by undo
      // itself or the stack looks empty.
      return { start, undid: undo(), back: pos(1) };
    }, HELPERS);

    expect(r.undid).toBe(true);
    expect(r.back).toEqual(r.start);
  });

// --- what a step covers ----------------------------------------------------

test("scale is part of placement, and comes back with it", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const sc = document.querySelector("#sc");
    const start = S.place[1].scale;
    sc.value = "220"; sc.dispatchEvent(new Event("input", { bubbles:true }));
    sc.dispatchEvent(new Event("change", { bubbles:true }));
    const scaled = S.place[1].scale;
    undo();
    return { start, scaled, back: S.place[1].scale, slider: sc.value };
  }, HELPERS);

  expect(r.scaled).toBeCloseTo(2.2, 6);
  expect(r.back).toBeCloseTo(r.start, 6);
  // The control has to show the restored value, not the one it was dragged to.
  expect(r.slider).toBe("100");
});

test("Recenter can be taken back", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    drag(70, 30);
    const placed = pos(1);
    document.querySelector("#center").click();
    const centred = pos(1);
    undo();
    return { placed, centred, back: pos(1) };
  }, HELPERS);

  // The issue's complaint exactly: Recenter reset to the middle rather than
  // returning you to where you were, and there was no way back.
  expect(r.centred).not.toEqual(r.placed);
  expect(r.back).toEqual(r.placed);
});

test("an undo selects the layer it restored", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    drag(40, 0);                                   // overlay is selected
    document.querySelector("#lyBase").click();     // now the base
    drag(0, 25);
    undo();                                        // undoes the base move
    const afterFirst = { sel: S.sel,
      pressed: document.querySelector("#lyBase").getAttribute("aria-pressed") };
    undo();                                        // undoes the overlay move
    return { afterFirst, sel: S.sel,
             overPressed: document.querySelector("#lyOver").getAttribute("aria-pressed"),
             px: document.querySelector("#px").value, overX: pos(1).x };
  }, HELPERS);

  expect(r.afterFirst.sel).toBe(0);
  expect(r.afterFirst.pressed).toBe("true");
  // Restoring the overlay while the base is selected would leave the size
  // slider and the position fields describing a layer that did not change.
  expect(r.sel).toBe(1);
  expect(r.overPressed).toBe("true");
  expect(r.px).toBe(String(r.overX));
});

// --- reach -----------------------------------------------------------------

test("the usual chords work, and are left alone inside a field",
  async ({ page }) => {
    await open(page); await load(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      const start = pos(1);
      drag(64, 0);
      const moved = pos(1);

      const chord = (key, opts) => {
        const e = new KeyboardEvent("keydown",
          { key, bubbles:true, cancelable:true, ...(opts||{}) });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const undoPrevented = chord("z", { metaKey:true });
      const afterUndo = pos(1);
      chord("z", { metaKey:true, shiftKey:true });
      const afterRedo = pos(1);
      chord("z", { ctrlKey:true });
      const afterCtrlZ = pos(1);
      chord("y", { ctrlKey:true });
      const afterCtrlY = pos(1);

      // Inside a number field the browser's own text undo is what is meant.
      const px = document.querySelector("#px");
      px.focus();
      const e = new KeyboardEvent("keydown",
        { key:"z", metaKey:true, bubbles:true, cancelable:true });
      px.dispatchEvent(e);
      return { start, moved, undoPrevented, afterUndo, afterRedo, afterCtrlZ,
               afterCtrlY, inFieldPrevented: e.defaultPrevented, afterInField: pos(1) };
    }, HELPERS);

    expect(r.undoPrevented).toBe(true);
    expect(r.afterUndo).toEqual(r.start);
    expect(r.afterRedo).toEqual(r.moved);
    expect(r.afterCtrlZ).toEqual(r.start);
    expect(r.afterCtrlY).toEqual(r.moved);
    expect(r.inFieldPrevented).toBe(false);
    expect(r.afterInField).toEqual(r.moved);
  });

test("the button offers an undo the chord would also give you", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const start = pos(1);
    for (let i = 0; i < 8; i++) press("ArrowRight");
    // The gesture is still open, so nothing has reached `past` yet -- but undo()
    // closes it, so the action is genuinely available and the button has to say
    // so rather than reading `past.length` and claiming otherwise.
    const committed = past.length;
    const offered = !document.querySelector("#undo").disabled;
    document.querySelector("#undo").click();
    return { start, committed, offered, back: pos(1) };
  }, HELPERS);

  expect(r.committed).toBe(0);
  expect(r.offered).toBe(true);
  expect(r.back).toEqual(r.start);
});

test("the buttons say whether there is anything to undo", async ({ page }) => {
  await open(page); await load(page);
  const r = await page.evaluate(async (h) => {
    eval(h);
    const u = document.querySelector("#undo"), rd = document.querySelector("#redo");
    const atStart = { u: u.disabled, r: rd.disabled };
    drag(30, 0);
    endChange();
    const afterMove = { u: u.disabled, r: rd.disabled };
    u.click();
    const afterUndo = { u: u.disabled, r: rd.disabled };
    rd.click();
    return { atStart, afterMove, afterUndo, afterRedo: { u: u.disabled, r: rd.disabled } };
  }, HELPERS);

  expect(r.atStart).toEqual({ u: true, r: true });
  expect(r.afterMove).toEqual({ u: false, r: true });
  expect(r.afterUndo).toEqual({ u: true, r: false });
  expect(r.afterRedo).toEqual({ u: false, r: true });
});
