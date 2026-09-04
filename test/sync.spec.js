// Sync modes: does Auto pick the right one, and does the strip agree (#23).
//
// The corpus GIFs have fixed durations, and this needs specific ones, so the
// sources here are built directly. A source is just {frames, starts, duration,
// static, ...}, which is what loadSource returns, so nothing is being faked
// that planTimeline can tell apart.
//
// PLAN.md section 6's table is the centrepiece. Section 3's merge invariants --
// the union of both sources' boundaries rather than a fixed rate, the 20ms
// minimum gap, uniform resampling only past the frame budget -- are checked
// alongside it, because they are what the mode choice feeds.

const { test, expect } = require("@playwright/test");

const HELPERS = `
// n frames of equal delay spanning durationMs; n === 1 is a still, which
// loadSource reports with duration 0.
async function make(name, durationMs, n){
  const frames = [];
  for (let i = 0; i < n; i++){
    const c = new OffscreenCanvas(8, 8), cx = c.getContext("2d");
    cx.fillStyle = "hsl(" + (i * 60) + ",80%,50%)";
    cx.fillRect(0, 0, 8, 8);
    frames.push({bitmap: await createImageBitmap(c), delay: durationMs / n});
  }
  const starts = []; let t = 0;
  for (const f of frames){ starts.push(t); t += f.delay; }
  const isStatic = n === 1;
  return {name, kind: "gif", width: 8, height: 8, frames, starts,
          duration: isStatic ? 0 : t, static: isStatic, thumb: null, meta: ""};
}

// Explicit boundary times, for when the gaps themselves are the subject.
async function makeAt(name, starts, durationMs){
  const frames = [];
  for (let i = 0; i < starts.length; i++){
    const c = new OffscreenCanvas(8, 8), cx = c.getContext("2d");
    cx.fillStyle = "hsl(" + (i * 60) + ",80%,50%)";
    cx.fillRect(0, 0, 8, 8);
    const next = i + 1 < starts.length ? starts[i + 1] : durationMs;
    frames.push({bitmap: await createImageBitmap(c), delay: next - starts[i]});
  }
  return {name, kind: "gif", width: 8, height: 8, frames, starts: starts.slice(),
          duration: durationMs, static: false, thumb: null, meta: ""};
}

async function planForStarts(baseStarts, overStarts, durationMs){
  if (S.src[0]) disposeSource(0);
  if (S.src[1]) disposeSource(1);
  S.src[0] = await makeAt("base", baseStarts, durationMs);
  S.src[1] = await makeAt("over", overStarts, durationMs);
  S.sync = "auto"; S.maxFrames = 180;
  replan();
  return S.plan;
}

async function planFor(baseMs, baseN, overMs, overN, sync){
  if (S.src[0]) disposeSource(0);
  if (S.src[1]) disposeSource(1);
  S.src[0] = await make("base", baseMs, baseN);
  S.src[1] = await make("over", overMs, overN);
  S.sync = sync || "auto";
  S.maxFrames = 180;
  replan();
  return S.plan;
}

// What drawTimeline puts in each lane, without drawing it.
function lanes(){
  const [A, B] = S.src, plan = S.plan;
  return {
    base: repeated(A, plan.kA, plan.outDur).length,
    output: plan.times.length,
    overlay: repeated(B, plan.kB, plan.outDur).length,
  };
}
`;

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
});

// PLAN.md section 6, verbatim. "still" is a single-frame source, which
// effDurations() treats as taking the other side's duration; with both static
// it invents 1000ms, because something has to be chosen.
const TABLE = [
  { base: [1000, 4], over: [1000, 4], mode: "lcm", outDur: 1000, why: "identical, trivial" },
  { base: [1200, 3], over: [800, 2], mode: "lcm", outDur: 2400, why: "clean 2:3 loop" },
  { base: [1230, 3], over: [800, 2], mode: "stretch", outDur: 1230, why: "LCM would be 98s" },
  { base: [5000, 2], over: [100, 2], mode: "stretch", outDur: 5000, why: "large integer ratio" },
  { base: [0, 1], over: [2000, 4], mode: "lcm", outDur: 2000, why: "a still adds no boundaries" },
  { base: [0, 1], over: [0, 1], mode: "lcm", outDur: 1000, why: "both static, duration invented" },
];

for (const row of TABLE) {
  const label = `${row.base[1] === 1 ? "still" : row.base[0] + "ms"} over ` +
                `${row.over[1] === 1 ? "still" : row.over[0] + "ms"}`;
  test(`Auto: ${label} -> ${row.mode}, ${row.outDur}ms (${row.why})`, async ({ page }) => {
    const plan = await page.evaluate(async ({ helpers, r }) => {
      eval(helpers);
      const p = await planFor(r.base[0], r.base[1], r.over[0], r.over[1], "auto");
      return { mode: p.mode, outDur: p.outDur, count: p.count, kA: p.kA, kB: p.kB,
               resampled: p.resampled, times: p.times };
    }, { helpers: HELPERS, r: row });

    expect(plan.mode).toBe(row.mode);
    // outDur is the sum of the emitted delays, so it can differ from the
    // nominal figure by the 20ms floor; anything larger is a real disagreement.
    expect(Math.abs(plan.outDur - row.outDur)).toBeLessThanOrEqual(20);
    expect(plan.resampled).toBe(false);
  });
}

test("stretch retimes the overlay by whole repetitions", async ({ page }) => {
  const r = await page.evaluate(async (helpers) => {
    eval(helpers);
    const p = await planFor(5000, 2, 100, 2, "auto");
    // reps = round(5000/100) = 50, so the overlay runs 50 times inside one
    // pass of the base and kB comes out at exactly 1.
    return { mode: p.mode, kA: p.kA, kB: p.kB, outDur: p.outDur,
             reps: Math.round(5000 / 100) };
  }, HELPERS);

  expect(r.mode).toBe("stretch");
  expect(r.reps).toBe(50);
  expect(r.kA).toBe(1);
  expect(r.kB).toBeCloseTo(1, 6);
});

test("each mode can be forced, and Auto is the only one that chooses",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      const out = {};
      for (const mode of ["auto", "lcm", "stretch", "shortest", "longest"]) {
        const p = await planFor(1230, 3, 800, 2, mode);
        out[mode] = { mode: p.mode, outDur: p.outDur };
      }
      return out;
    }, HELPERS);

    // Auto would pick stretch for this pair; every forced mode must override it.
    expect(r.auto.mode).toBe("stretch");
    expect(r.lcm.mode).toBe("lcm");
    expect(r.stretch.mode).toBe("stretch");
    expect(r.shortest.mode).toBe("shortest");
    expect(r.longest.mode).toBe("longest");

    expect(Math.abs(r.shortest.outDur - 800)).toBeLessThanOrEqual(20);
    expect(Math.abs(r.longest.outDur - 1230)).toBeLessThanOrEqual(20);
    // lcm(1230, 800) is 98.4s, capped at 60s.
    expect(r.lcm.outDur).toBeLessThanOrEqual(60000);
    expect(r.lcm.outDur).toBeGreaterThan(50000);
  });

test("the timeline strip's three lanes agree with the plan", async ({ page }) => {
  const r = await page.evaluate(async (helpers) => {
    eval(helpers);
    const p = await planFor(1200, 3, 800, 2, "auto");
    const l = lanes();
    return { lanes: l, count: p.count, outDur: p.outDur, mode: p.mode,
             modeText: document.querySelector("#syncNote").textContent,
             dims: document.querySelector("#dims").textContent };
  }, HELPERS);

  // The OUTPUT lane is drawn straight from plan.times, so the count the strip
  // labels itself with has to be the plan's frame count.
  expect(r.lanes.output).toBe(r.count);
  // 2400ms of a 1200ms base is 2 passes of 3 frames; of an 800ms overlay, 3
  // passes of 2. Both lanes fill the whole strip rather than stopping early.
  expect(r.lanes.base).toBe(6);
  expect(r.lanes.overlay).toBe(6);
  expect(r.modeText.length).toBeGreaterThan(0);
});

test("boundaries are the union of both sources, not a fixed sample rate",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      // Frame lengths have to be incommensurate for the union to be uneven.
      // 1200/3 gives 400ms; 800/2 also gives 400ms, so that pair produces a
      // perfectly uniform union and proves nothing. 900/4 gives 225ms.
      const p = await planFor(1200, 3, 900, 4, "auto");
      const gaps = p.times.slice(1).map((t, i) => t - p.times[i]);
      return { times: p.times, gaps, count: p.count, resampled: p.resampled,
               distinctGaps: [...new Set(gaps)].length };
    }, HELPERS);

    expect(r.resampled).toBe(false);
    // A fixed sample rate would give one gap value repeated. The union of two
    // sources with different frame lengths cannot.
    expect(r.distinctGaps).toBeGreaterThan(1);
    // PLAN.md section 3: anything closer than 20ms cannot survive GIF's
    // centisecond timing, so the merge drops it.
    expect(Math.min(...r.gaps)).toBeGreaterThanOrEqual(20);
  });

test("the merge drops a boundary closer than 20ms to the one before it",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      // Base changes at 500, overlay at 505. Three marks in total, far below
      // the frame budget, so resampling cannot be what enforces the gap -- this
      // reaches the merge floor itself.
      const p = await planForStarts([0, 500], [0, 505], 1000);
      return { times: p.times, count: p.count, resampled: p.resampled,
               gaps: p.times.slice(1).map((t, i) => t - p.times[i]) };
    }, HELPERS);

    expect(r.resampled, "resampling would enforce the gap for the wrong reason")
      .toBe(false);
    // 505 is 5ms after 500 and must be dropped: PLAN.md section 3 says anything
    // tighter cannot survive GIF's centisecond timing.
    expect(r.count).toBe(2);
    expect(r.times).toEqual([0, 500]);
  });

// Sources changing far faster than 20ms do not reach the resampler at all: the
// merge floor has already thinned them out. This is what makes the `Math.max(20,
// ...)` clamp inside the resampling step unreachable -- see the note on the
// resampling test below.
test("boundaries far tighter than 20ms are thinned by the merge, not by resampling",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      // 200 frames in 1000ms is a boundary every 5ms on both sides.
      const p = await planFor(1000, 200, 1000, 200, "auto");
      const gaps = p.times.slice(1).map((t, i) => t - p.times[i]);
      return { count: p.count, min: Math.min(...gaps), resampled: p.resampled,
               minDelay: Math.min(...p.delaysMs) };
    }, HELPERS);

    // 1000ms with a 20ms floor cannot hold more than 50 boundaries, which is
    // under the 180 budget -- so resampling never runs.
    expect(r.resampled).toBe(false);
    expect(r.count).toBeLessThanOrEqual(51);
    expect(r.min).toBeGreaterThanOrEqual(20);
    expect(r.minDelay).toBeGreaterThanOrEqual(20);
  });

test("uniform resampling kicks in only past the frame budget", async ({ page }) => {
  const r = await page.evaluate(async (helpers) => {
    eval(helpers);
    const out = {};
    // Well inside the budget: boundaries stay where the sources put them.
    S.maxFrames = 180;
    let p = await planFor(1200, 3, 900, 4, "auto");
    out.under = { count: p.count, resampled: p.resampled,
                  distinctGaps: [...new Set(p.times.slice(1).map((t, i) => t - p.times[i]))].length };

    // Same sources, budget cut below the union: now it must resample evenly.
    S.maxFrames = 12;
    replan();
    p = S.plan;
    out.over = { count: p.count, resampled: p.resampled,
                 gaps: p.times.slice(1).map((t, i) => t - p.times[i]),
                 distinctGaps: [...new Set(p.times.slice(1).map((t, i) => t - p.times[i]))].length };
    return out;
  }, HELPERS);

  expect(r.under.resampled).toBe(false);
  expect(r.over.resampled).toBe(true);
  // Every resampled gap is at least 20ms -- but by arithmetic rather than by the
  // clamp that appears to enforce it. After the merge, times are at least 20ms
  // apart, so there can be at most outDur/20 of them; resampling only runs when
  // that exceeds maxFrames, which means outDur/maxFrames is already >= 20 and
  // `Math.max(20, ...)` in the step can never change the value. Dead code, and
  // no fixture can make it fire.
  expect(Math.min(...r.over.gaps)).toBeGreaterThanOrEqual(20);
  expect(r.over.count).toBeLessThanOrEqual(13);
  // Resampled means evenly spaced -- one gap value, where the union had several.
  expect(r.over.distinctGaps).toBe(1);
  expect(r.under.distinctGaps).toBeGreaterThan(1);
});

test("sampling at times[i] + 1 agrees with the middle of the interval",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      // A stretch pair, so kB is fractional (1230 / (800 * 2) = 0.76875) and
      // t/k lands on non-integers. With kA = kB = 1 the arithmetic is exact and
      // there is nothing for the epsilon to protect against.
      const p = await planFor(1230, 3, 800, 2, "auto");
      const [A, B] = S.src;
      const rows = [];
      for (let i = 0; i < p.times.length; i++) {
        const t = p.times[i], mid = t + p.delaysMs[i] / 2;
        rows.push({
          edge: [frameAt(A, t, p.kA), frameAt(B, t, p.kB)],
          plusOne: [frameAt(A, t + 1, p.kA), frameAt(B, t + 1, p.kB)],
          middle: [frameAt(A, mid, p.kA), frameAt(B, mid, p.kB)],
        });
      }
      return { mode: p.mode, kB: p.kB, rows };
    }, HELPERS);

    expect(r.mode).toBe("stretch");
    expect(r.kB).not.toBe(1);

    // The property that matters: +1ms resolves to the same frame as the middle
    // of the interval does. That is what "inside the interval rather than on a
    // boundary" means, and it is checkable without depending on whether the
    // exact boundary happens to be ambiguous for a given fixture.
    for (const row of r.rows) {
      expect(row.plusOne).toEqual(row.middle);
      for (const idx of row.plusOne) expect(idx).toBeGreaterThanOrEqual(0);
    }

    // How often the exact boundary would have disagreed. PLAN.md section 3 says
    // frameAt "could resolve to either neighbouring frame" there; on this
    // fixture it is 0, so the epsilon is defensive rather than load-bearing
    // here. Reported, not asserted -- it depends entirely on the durations.
    const ambiguous = r.rows.filter((x) => x.edge[0] !== x.middle[0] ||
                                           x.edge[1] !== x.middle[1]).length;
    console.log(`      boundaries where the exact time disagreed with the interior: ` +
                `${ambiguous} of ${r.rows.length}`);
  });
