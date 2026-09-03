// A render must not be disturbed by what the user does while it runs (#27).
//
// The hazard is quieter than "replan() replaces S.plan". render() captures the
// plan, so the encode loop keeps iterating the object it started with. But
// composite() used to read S.plan for the retiming factors kA and kB, so a
// replan mid-render left the sampler drawing from one timeline while the
// durations came from another. Same for opacity, scale, placement, blend and
// background, all of which composite() read live.
//
// The fix is a snapshot: renderView() freezes everything composite() reads, and
// the render draws from that. replan() defers while busy, and loading a source
// is refused outright, because disposeSource() closes the very ImageBitmaps the
// encoder is drawing from.

const { test, expect } = require("@playwright/test");

async function setup(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
  return page.evaluate(async () => {
    async function loadInto(i, name) {
      const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
      const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
      if (S.src[i]) disposeSource(i);
      S.src[i] = src;
    }
    await loadInto(0, "05-subrect.gif");
    await loadInto(1, "06-delay-zero.gif");
    S.outScale = 4;
    S.sync = "auto";
    replan();
    return { count: S.plan.count, mode: S.plan.mode };
  });
}

// Hash the bytes so three renders can be compared without shipping them out.
const HASH = `async function hash(blob){
  const b = new Uint8Array(await blob.arrayBuffer());
  let h = 5381;
  for (let i = 0; i < b.length; i++) h = ((h * 33) ^ b[i]) >>> 0;
  return h + ":" + b.length;
}`;

test("a change made mid-render does not land in the output", async ({ page }) => {
  await setup(page);

  const r = await page.evaluate(async (hashSrc) => {
    eval(hashSrc);
    const g = geometry();
    const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
    const run = async (opacity, mutateTo) => {
      S.opacity = opacity;
      const plan = S.plan;
      const view = renderView(plan);
      const p = exportGIF(W, H, g, plan, () => {}, view);
      // Lands after exportGIF has yielded at its first await, i.e. while the
      // frames are being composited -- exactly the race being guarded against.
      if (mutateTo !== undefined) S.opacity = mutateTo;
      const out = await hash(await p);
      S.opacity = 1;
      return out;
    };

    const baseline = await run(1);
    const raced = await run(1, 0.05);
    const control = await run(0.05);
    return { baseline, raced, control };
  }, HASH);

  // The control proves opacity actually changes the bytes, so the equality
  // below means something. Without it this test would pass on a no-op.
  expect(r.control).not.toBe(r.baseline);
  expect(r.raced).toBe(r.baseline);
});

test("replan() defers while a render is running, and lands afterwards", async ({ page }) => {
  await setup(page);

  const r = await page.evaluate(async () => {
    const g = geometry();
    const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
    const before = S.plan;

    busy = true;                       // stand in for a render in flight
    S.sync = "stretch";
    replan();
    const duringIsSame = S.plan === before;

    busy = false;
    if (queuedReplan) { queuedReplan = false; replan(); }
    const afterIsNew = S.plan !== before;

    return { duringIsSame, afterIsNew, mode: S.plan.mode };
  });

  expect(r.duringIsSame, "replan changed S.plan while busy").toBe(true);
  expect(r.afterIsNew, "the deferred replan never ran").toBe(true);
  expect(r.mode).toBe("stretch");
});

test("the deferred replan runs even when the render throws", async ({ page }) => {
  await setup(page);

  const r = await page.evaluate(async () => {
    const before = S.plan;
    const original = window.exportGIF;
    // Gate the failure so the render is provably still in flight when the
    // replan is queued. Without the gate it throws immediately, busy is already
    // false, and replan() takes the ordinary path -- the test then passes while
    // testing nothing, which is how the drain came to be unguarded.
    let release;
    const gate = new Promise((r) => { release = r; });
    window.exportGIF = async () => { await gate; throw new Error("deliberate"); };
    let deferredWhileBusy = null;
    try {
      document.querySelector("#fmt").value = "gif";
      document.querySelector("#fmt").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#render").click();
      await new Promise((r) => setTimeout(r, 0));      // let render() set busy

      S.sync = "stretch";
      replan();
      deferredWhileBusy = busy === true && queuedReplan === true && S.plan === before;

      release();
      const t0 = performance.now();
      while (performance.now() - t0 < 10000) {
        await new Promise((r) => setTimeout(r, 20));
        if (!document.querySelector("#render").disabled) break;
      }
    } finally {
      window.exportGIF = original;
    }
    return { busy, queuedReplan, deferredWhileBusy, planChanged: S.plan !== before,
             enabled: !document.querySelector("#render").disabled };
  });

  // A render that throws must not leave the app wedged: the flag has to clear
  // and the deferred replan still has to happen.
  expect(r.deferredWhileBusy, "the replan was not actually deferred").toBe(true);
  expect(r.busy).toBe(false);
  expect(r.queuedReplan).toBe(false);
  expect(r.enabled).toBe(true);
  expect(r.planChanged).toBe(true);
});

test("loading a source is refused while a render is running", async ({ page }) => {
  await setup(page);

  const r = await page.evaluate(async () => {
    const before = S.src[0];
    const buf = await (await fetch("/corpus/01-interlaced.gif")).arrayBuffer();
    const file = new File([buf], "01-interlaced.gif", { type: "image/gif" });

    busy = true;
    await accept(0, file);
    const slot = document.querySelector('.slot[data-i="0"]');
    const message = slot.querySelector(".meta") ? slot.querySelector(".meta").textContent : "";
    const unchanged = S.src[0] === before;
    busy = false;

    // And it works again once the render is done.
    await accept(0, file);
    const swapped = S.src[0] !== before && S.src[0].name === "01-interlaced.gif";
    return { unchanged, message, swapped };
  });

  // Refused, not queued: disposeSource() would close bitmaps the encoder is
  // still drawing from, which throws mid-encode rather than merely looking odd.
  expect(r.unchanged).toBe(true);
  expect(r.message).toContain("Rendering");
  expect(r.swapped).toBe(true);
});
