// The interface pass (#65).
//
// The complaints in that issue were mostly measurable, so these are mostly
// measurements. Two are worth saying out loud:
//
// The preview was sized to the source, capped at 560px -- so a 32x32 GIF was
// drawn 32px wide inside an 840px panel. The subject of the tool, and the thing
// the user drags, was the smallest element on the page. It now fits its panel.
//
// Yellow meant four unrelated things: the active segmented state, every slider
// fill, the primary button, and the OUTPUT lane. A colour used for everything
// emphasises nothing, so it now means the output and only the output. That is
// the kind of rule that decays silently, so it is asserted rather than trusted.

const { test, expect } = require("./fixtures");

const DESKTOP = { width: 1440, height: 1100 };

const LOAD = `
async function li(i, n){
  const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
  const src = await loadSource(new File([buf], n, {type:"image/gif"}), () => {});
  if (S.src[i]) disposeSource(i);
  S.src[i] = src; renderSlot(i);
}
async function two(){ await li(0,"05-subrect.gif"); await li(1,"01-interlaced.gif"); replan(); }
// A declaration, not a const: only declarations leak out of a direct eval into
// the scope that called it, which is where every test below uses this.
function frame(){
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}
`;

async function open(page, size = DESKTOP) {
  await page.setViewportSize(size);
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}

// --- the subject fills the space it is given -------------------------------

test("a source far smaller than its panel is shown at the panel's size",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await two(); await frame();
      const st = document.querySelector("#stage");
      const box = document.querySelector(".stage").getBoundingClientRect();
      return { natural: st.width, shown: st.getBoundingClientRect().width,
               panel: box.width, panelH: box.height,
               shownH: st.getBoundingClientRect().height };
    }, LOAD);

    // The corpus pair is 32px square; it used to be displayed at exactly that.
    expect(r.natural).toBe(32);
    expect(r.shown).toBeGreaterThan(400);
    // Filling the panel means filling it, without spilling out of it.
    expect(r.shown).toBeLessThanOrEqual(r.panel);
    expect(r.shownH).toBeLessThanOrEqual(r.panelH);
    // Square in, square out.
    expect(r.shown).toBeCloseTo(r.shownH, 0);
  });

test("the scale being shown is a whole number, so a pixel stays square",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await two(); await frame();
      const st = document.querySelector("#stage");
      return { ratio: st.getBoundingClientRect().width / st.width,
               label: document.querySelector("#zoomPct").textContent };
    }, LOAD);

    // A fractional upscale under image-rendering:pixelated makes some source
    // pixels a row wider than their neighbours, which reads as a bad file.
    expect(r.ratio).toBeCloseTo(Math.round(r.ratio), 6);
    expect(r.ratio).toBeGreaterThan(1);
    expect(r.label).toBe(Math.round(r.ratio * 100) + "%");
  });

test("fitting the preview does not feed back into the layout", async ({ page }) => {
  // Fit reads the panel and sizes the canvas; if the canvas can size the panel
  // back, the two chase each other. It settled at different scales in Chromium
  // and WebKit and ran to the 32x ceiling in Firefox, so the symptom was a
  // preview that was merely "wrong on one browser" rather than an obvious loop.
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await two(); await frame();
    const st = document.querySelector("#stage");
    const panel = document.querySelector(".panel.grow");
    const widths = [], heights = [];
    for (let i = 0; i < 6; i++){
      await frame();
      widths.push(Math.round(st.getBoundingClientRect().width));
      heights.push(Math.round(panel.getBoundingClientRect().height));
    }
    return { widths, heights,
             position: getComputedStyle(st).position,
             zoom: document.querySelector("#zoomPct").textContent };
  }, LOAD);

  // Every frame agrees, rather than creeping upward.
  expect(new Set(r.widths).size, `preview size drifted: ${r.widths}`).toBe(1);
  expect(new Set(r.heights).size, `panel height drifted: ${r.heights}`).toBe(1);
  // The mechanism, asserted directly: in flow, it can size its ancestors again.
  expect(r.position).toBe("absolute");
});

test("the zoom controls step, and Fit comes back", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await two(); await frame();
    const st = document.querySelector("#stage");
    const width = () => st.getBoundingClientRect().width;
    const fit = width(), fitPressed = document.querySelector("#zoomFit").getAttribute("aria-pressed");

    document.querySelector("#zoomOut").click(); await frame();
    const out = width(), outPressed = document.querySelector("#zoomFit").getAttribute("aria-pressed");
    document.querySelector("#zoomIn").click(); await frame();
    const back = width();

    /* Fit is clicked from a scale it is not already at. Stepping out and back
       lands on the fit value again -- the ladder includes it -- so clicking Fit
       from there proves nothing: the width would match whether the button did
       anything or not. */
    document.querySelector("#zoomOut").click();
    document.querySelector("#zoomOut").click(); await frame();
    const away = width();
    document.querySelector("#zoomFit").click(); await frame();
    return { fit, fitPressed, out, outPressed, back, away, refit: width(),
             refitPressed: document.querySelector("#zoomFit").getAttribute("aria-pressed") };
  }, LOAD);

  expect(r.fitPressed).toBe("true");
  expect(r.out).toBeLessThan(r.fit);
  // Stepping is a manual choice, so Fit stops claiming to be in charge.
  expect(r.outPressed).toBe("false");
  expect(r.back).toBeCloseTo(r.fit, 0);
  expect(r.away).toBeLessThan(r.fit);
  expect(r.refit).toBeCloseTo(r.fit, 0);
  expect(r.refitPressed).toBe("true");
});

test("dragging moves a layer by the same amount at any zoom", async ({ page }) => {
  // The drag converts pointer pixels to canvas pixels through the displayed
  // width, so zooming in makes the drag finer rather than wrong. If that
  // conversion is ever hard-coded back to a fixed size, this catches it.
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await two(); await frame();
    const stage = document.querySelector("#stage");
    S.sel = 1;

    async function dragAcross(){
      const w = stage.getBoundingClientRect().width;
      const x0 = S.place[1].x;
      stage.dispatchEvent(new PointerEvent("pointerdown",
        { bubbles:true, clientX:0, clientY:0, pointerId:1 }));
      stage.dispatchEvent(new PointerEvent("pointermove",
        { bubbles:true, clientX:w, clientY:0, pointerId:1 }));
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles:true, pointerId:1 }));
      await frame();
      return S.place[1].x - x0;
    }

    const atFit = await dragAcross();
    document.querySelector("#zoomOut").click();
    document.querySelector("#zoomOut").click(); await frame();
    const zoomedOut = await dragAcross();
    return { atFit, zoomedOut, expected: stage.width / S.src[0].width };
  }, LOAD);

  // Dragging the full width of the displayed image moves the layer by one
  // canvas width, whatever that image is currently displayed at.
  expect(r.atFit).toBeCloseTo(r.expected, 3);
  expect(r.zoomedOut).toBeCloseTo(r.expected, 3);
});

// --- the empty state -------------------------------------------------------

test("the preview says where to start before anything is loaded", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const empty = document.querySelector("#empty");
    return { hidden: empty.hidden, canvasHidden: document.querySelector("#stage").hidden,
             visible: empty.getBoundingClientRect().height > 0,
             text: empty.innerText };
  });

  expect(r.hidden).toBe(false);
  expect(r.visible).toBe(true);
  // The canvas would otherwise sit behind the message as an empty checkerboard.
  expect(r.canvasHidden).toBe(true);
  expect(r.text).toMatch(/drop/i);
});

test("the empty state gets out of the way as soon as a source is loaded",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h);
      await li(0, "05-subrect.gif"); replan(); await frame();
      const empty = document.querySelector("#empty");
      // One source is enough: the preview already has something to show.
      const afterOne = { hidden: empty.hidden, h: empty.getBoundingClientRect().height,
                         canvasHidden: document.querySelector("#stage").hidden };
      await li(1, "01-interlaced.gif"); replan(); await frame();
      return { afterOne, afterTwo: { hidden: empty.hidden } };
    }, LOAD);

    expect(r.afterOne.hidden).toBe(true);
    expect(r.afterOne.h).toBe(0);
    expect(r.afterOne.canvasHidden).toBe(false);
    expect(r.afterTwo.hidden).toBe(true);
  });

// --- hierarchy and layout --------------------------------------------------

test("the plan sits under the timeline it describes, not inside the sliders",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await two(); await frame();
      const R = document.querySelector("#readout");
      const fig = getComputedStyle(R.querySelector(".fig"));
      const sliderLabel = getComputedStyle(document.querySelector("label.k"));
      return {
        insideTimelinePanel: R.closest(".panel").contains(document.querySelector("#timeline")),
        belowTimeline: R.getBoundingClientRect().top >=
                       document.querySelector("#timeline").getBoundingClientRect().bottom,
        figSize: parseFloat(fig.fontSize), labelSize: parseFloat(sliderLabel.fontSize),
        text: R.innerText,
      };
    }, LOAD);

    expect(r.insideTimelinePanel).toBe(true);
    expect(r.belowTimeline).toBe(true);
    // It used to be set at the same size as the label of a slider.
    expect(r.figSize).toBeGreaterThan(r.labelSize * 1.5);
    expect(r.text).toMatch(/OUTPUT/i);
    expect(r.text).toMatch(/Exact frame boundaries preserved/);
  });

test("the two desktop columns end together", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await two(); await frame();
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    return { left: box(".col.main").bottom, right: box(".col:not(.main)").bottom,
             page: document.documentElement.scrollHeight };
  }, LOAD);

  // The left column used to stop at about 830px against the right's 1560 --
  // some 700px of empty ground, close to half the visible page.
  expect(Math.abs(r.left - r.right)).toBeLessThan(24);
});

test("the narrow layout still stacks, and the preview stays bounded",
  async ({ page }) => {
    await open(page, { width: 420, height: 900 });
    const r = await page.evaluate(async (h) => {
      eval(h); await two(); await frame();
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      return { main: box(".col.main"), side: box(".col:not(.main)"),
               stage: box(".stage").height, stageEl: box("#stage").width };
    }, LOAD);

    // One column: the controls start below the preview rather than beside it.
    expect(r.side.top).toBeGreaterThan(r.main.top);
    // Unbounded growth here would push every control off the screen.
    expect(r.stage).toBeLessThan(700);
    expect(r.stageEl).toBeLessThanOrEqual(r.side.width);
  });

// --- the colour rule -------------------------------------------------------

test("yellow means the output, and nothing else", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await two(); await frame();
    const YELLOW = /255,\s*204,\s*0/;
    const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") +
      (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : "");
    const users = [...document.querySelectorAll("*")].filter((e) => {
      const c = getComputedStyle(e);
      return [c.color, c.backgroundColor, c.borderTopColor, c.accentColor]
        .some((v) => YELLOW.test(v));
    });
    return {
      names: users.map(name),
      // Each one has to be part of the output, not merely near it.
      outputOnly: users.every((e) =>
        e.closest("#readout .out") || e.id === "render" || e.closest(".legend span:nth-child(2)")),
    };
  }, LOAD);

  expect(r.outputOnly, `yellow leaked to: ${r.names.join(", ")}`).toBe(true);
  // And it is genuinely still in use -- the rule is not satisfied by absence.
  expect(r.names.length).toBeGreaterThan(2);
});

test("a slider and a plain segmented control are not painted as emphasis",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const YELLOW = /255,\s*204,\s*0/;
      const g = (s, p) => getComputedStyle(document.querySelector(s))[p];
      document.querySelector("#cvFit").click();
      return {
        slider: g("#op", "accentColor"),
        canvasSeg: g("#cvFit", "backgroundColor"),
        // The one segmented control that really is about the two lanes keeps
        // saying so, in the lanes' own colours.
        layerOver: g("#lyOver", "backgroundColor"),
        layerBase: (document.querySelector("#lyBase").click(),
                    g("#lyBase", "backgroundColor")),
        yellow: (v) => YELLOW.test(v),
      };
    });

    expect(r.slider).not.toMatch(/255,\s*204,\s*0/);
    expect(r.canvasSeg).not.toMatch(/255,\s*204,\s*0/);
    expect(r.layerBase).toMatch(/255,\s*51,\s*102/);     // --a, the base lane
  });

test("pink used as text clears AA on every ground it sits on", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const hex = (h) => { h = h.replace("#",""); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)); };
    const lum = (h) => { const [r,g,b] = hex(h).map((c) => { c /= 255;
      return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b; };
    const ratio = (a,b) => { const x = lum(a), y = lum(b);
      return (Math.max(x,y)+0.05) / (Math.min(x,y)+0.05); };
    const ink = v("--a-ink");
    return {
      ink,
      grounds: ["--ground","--panel","--panel-2"].map((g) => ratio(ink, v(g))),
      slotLabel: getComputedStyle(document.querySelector('.slot[data-i="0"] .lbl')).color,
    };
  });

  // --a was 4.48:1 on --panel and 3.98:1 on --panel-2, so short pink labels and
  // warnings were under AA wherever they appeared.
  // An empty collection here would assert nothing at all.
  expect(r.grounds.length).toBeGreaterThan(0);
  for (const c of r.grounds) expect(c).toBeGreaterThanOrEqual(4.5);
  expect(r.slotLabel).toMatch(/255,\s*90,\s*130/);
});
