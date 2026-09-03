// Long renders must be interruptible (#28).
//
// Every encode loop already paused at `await idle()` to keep the page
// responsive. Those pauses are now `await breathe()`, which is the same yield
// plus a check for whether the user pressed Cancel while we were away -- so
// cancellation lands between frames rather than halfway through writing one.
//
// The interesting assertions here are not "it stopped" but "it stopped
// cleanly": no half-written file offered, the VideoEncoder closed rather than
// leaked, the busy flag cleared, and the app usable immediately afterwards.

const { test, expect } = require("@playwright/test");

// Enough frames that a cancel lands mid-render rather than racing the end.
// Each encode loop yields every fourth or eighth frame, so 55 gives a dozen or
// so chances to notice.
const LONG_PLAN = `
  S.plan = Object.assign({}, S.plan, {
    count: 55,
    times: Array.from({length: 55}, (_, i) => i * 800),
    delaysMs: Array(55).fill(800),
    delaysCs: Array(55).fill(80),
    outDur: 55 * 800,
  });
`;

async function setup(page, long = true) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  return page.evaluate(async ({ longPlan, useLong }) => {
    async function loadInto(i, name) {
      const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
      const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await loadInto(0, "05-subrect.gif");
    await loadInto(1, "06-delay-zero.gif");
    S.outScale = 8;
    S.sync = "auto";
    replan();
    if (useLong) eval(longPlan);
    return { count: S.plan.count };
  }, { longPlan: LONG_PLAN, useLong: long });
}

// Start a render, press Cancel once it is under way, wait for it to unwind.
const RUN_AND_CANCEL = `
async function runAndCancel(formatId){
  const sel = document.querySelector("#fmt");
  sel.value = formatId;
  sel.dispatchEvent(new Event("change", {bubbles: true}));
  document.querySelector("#out").innerHTML = "";
  document.querySelector("#render").click();
  await new Promise(r => setTimeout(r, 0));         // let render() get going
  const visibleWhileBusy = !document.querySelector("#cancel").hidden;
  document.querySelector("#cancel").click();
  const t0 = performance.now();
  while (performance.now() - t0 < 30000){
    await new Promise(r => setTimeout(r, 20));
    if (!document.querySelector("#render").disabled) break;
  }
  const out = document.querySelector("#out");
  return {
    visibleWhileBusy,
    text: out.textContent.trim(),
    download: !!out.querySelector("a.dl"),
    hiddenAfter: document.querySelector("#cancel").hidden,
    busy, cancelling,
    renderEnabled: !document.querySelector("#render").disabled,
  };
}`;

test.describe("cancelling a render", () => {
  for (const id of ["gif", "webp", "apng"]) {
    test(`${id}: stops without offering a partial file`, async ({ page }) => {
      await setup(page);
      const r = await page.evaluate(async ({ helper, fid }) => {
        eval(helper);
        return await runAndCancel(fid);
      }, { helper: RUN_AND_CANCEL, fid: id });

      expect(r.visibleWhileBusy, "the Cancel button was not shown").toBe(true);
      expect(r.text).toContain("Render cancelled");
      // The whole point: a stopped render must not hand over what it had so far.
      expect(r.download).toBe(false);
      expect(r.busy).toBe(false);
      expect(r.cancelling).toBe(false);
      expect(r.hiddenAfter).toBe(true);
      expect(r.renderEnabled).toBe(true);
    });
  }

  test("a coded format stops and closes its VideoEncoder", async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(async (helper) => {
      eval(helper);
      const coded = FORMATS.find((f) => f.kind === "iso" || f.kind === "ebml");
      if (!coded) return { skipped: true };

      // Watch every encoder the render builds, so the teardown can be checked
      // rather than assumed. Leaking one used to be the default on any throw.
      const made = [];
      const Real = window.VideoEncoder;
      window.VideoEncoder = class extends Real {
        constructor(...a) { super(...a); made.push(this); }
      };
      try {
        const out = await runAndCancel(coded.id);
        return { ...out, id: coded.id, states: made.map((e) => e.state), count: made.length };
      } finally {
        window.VideoEncoder = Real;
      }
    }, RUN_AND_CANCEL);

    test.skip(!!r.skipped, "no coded format available in this browser");
    expect(r.text).toContain("Render cancelled");
    expect(r.download).toBe(false);
    expect(r.count, "no VideoEncoder was constructed").toBeGreaterThan(0);
    for (const state of r.states) expect(state).toBe("closed");
  });
});

test("the app is immediately usable after a cancel", async ({ page }) => {
  await setup(page, false);           // ordinary short plan, so this one finishes
  const r = await page.evaluate(async (helper) => {
    eval(helper);
    eval(`S.plan = Object.assign({}, S.plan, {
      count: 55,
      times: Array.from({length: 55}, (_, i) => i * 800),
      delaysMs: Array(55).fill(800),
      delaysCs: Array(55).fill(80),
      outDur: 55 * 800,
    });`);
    const cancelled = await runAndCancel("gif");

    // Now render properly, without touching anything else.
    document.querySelector("#out").innerHTML = "";
    document.querySelector("#render").click();
    const t0 = performance.now();
    while (performance.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 20));
      if (!document.querySelector("#render").disabled &&
          document.querySelector("#out").innerHTML) break;
    }
    const out = document.querySelector("#out");
    return { cancelled, secondDownload: !!out.querySelector("a.dl"),
             secondText: out.textContent.trim().slice(0, 60) };
  }, RUN_AND_CANCEL);

  expect(r.cancelled.text).toContain("Render cancelled");
  expect(r.secondDownload, `second render said: ${r.secondText}`).toBe(true);
});

test("a replan queued during a cancelled render still lands", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(async (helper) => {
    eval(helper);
    const before = S.plan;
    document.querySelector("#fmt").value = "gif";
    document.querySelector("#render").click();
    await new Promise((r) => setTimeout(r, 0));
    S.sync = "stretch";
    replan();                                   // deferred by the busy guard
    const deferred = S.plan === before;
    document.querySelector("#cancel").click();
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 20));
      if (!document.querySelector("#render").disabled) break;
    }
    return { deferred, landed: S.plan !== before, queuedReplan, busy };
  }, RUN_AND_CANCEL);

  // Cancelling unwinds through the same finally as a failure, so the deferred
  // replan has to survive it.
  expect(r.deferred).toBe(true);
  expect(r.landed).toBe(true);
  expect(r.queuedReplan).toBe(false);
  expect(r.busy).toBe(false);
});

test("cancelling when nothing is running does nothing", async ({ page }) => {
  await setup(page, false);
  const r = await page.evaluate(async () => {
    const hiddenBefore = document.querySelector("#cancel").hidden;
    document.querySelector("#cancel").click();
    return { hiddenBefore, busy, cancelling,
             renderEnabled: !document.querySelector("#render").disabled };
  });
  expect(r.hiddenBefore).toBe(true);
  expect(r.cancelling).toBe(false);
  expect(r.busy).toBe(false);
  expect(r.renderEnabled).toBe(true);
});
