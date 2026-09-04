// The MediaRecorder fallback (#59).
//
// exportRecorder is what a browser with no VideoEncoder codec at all falls back
// to. It had never run in a test on any engine, for a benign reason: #19 found
// Chromium, Firefox and WebKit all expose a complete VideoEncoder codec set, so
// buildFormats() never reaches the branch that offers it. degrade.spec.js
// asserts the labelling conditionally, and the condition has never been true.
//
// So the branch is forced here rather than waited for, by deleting
// window.VideoEncoder before the page's scripts run -- the technique
// settings.spec.js already uses to make localStorage throw at startup.
//
// Real-time capture takes as long as the clip, so every test here uses one loop
// of a deliberately short plan.

const { test, expect } = require("./fixtures");

const NO_ENCODER = () => { delete window.VideoEncoder; };

const HELPERS = `
async function li(i, n){
  const buf = await (await fetch("/corpus/" + n)).arrayBuffer();
  const src = await loadSource(new File([buf], n, {type:"image/gif"}), () => {});
  if (S.src[i]) disposeSource(i);
  S.src[i] = src;
}
async function ready(){
  await li(0, "05-subrect.gif"); await li(1, "06-delay-zero.gif");
  S.sync = "auto"; S.loops = 1; S.outScale = 1;
  replan();
}
function dims(){
  const g = geometry();
  return { g, W: Math.max(2, Math.round(g.w*S.outScale) & ~1),
              H: Math.max(2, Math.round(g.h*S.outScale) & ~1) };
}
`;

async function open(page, { withEncoder = false } = {}) {
  if (!withEncoder) await page.addInitScript(NO_ENCODER);
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}

// --- the branch itself -----------------------------------------------------

test("with no VideoEncoder the recorder entries appear, and say what they are",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => ({
      all: FORMATS.map((f) => ({ id: f.id, label: f.label, kind: f.kind,
                                 recorder: !!f.recorder, note: f.note })),
      hasVideoEncoder: typeof VideoEncoder !== "undefined",
    }));

    expect(r.hasVideoEncoder).toBe(false);
    const rec = r.all.filter((f) => f.recorder);
    expect(rec.length).toBeGreaterThan(0);

    // Nobody should pick one of these without knowing what they are getting --
    // and the thing they most need to know is not that it is slow. Measured in
    // #59: a plan with 100/48/52/96/30 ms boundaries came back flat at ~67 ms,
    // drifting up to 30 ms, because the frames land on the capture clock. A
    // note that mentions only the waiting is the misleading half of the truth.
    for (const f of rec) {
      expect(f.label).toContain("real time");
      expect(f.note).toMatch(/real time/i);
      expect(f.note, "the note must admit the timing is not the timeline's")
        .toMatch(/capture clock|not.*timeline|rather than the merged timeline/i);
      expect(f.note, "and point at the formats that do keep exact timing")
        .toMatch(/GIF|WebP|APNG/);
      expect(f.kind).toBe("recorder");
    }
    // The still formats need no VideoEncoder and must survive its absence: they
    // are what keeps exact timing on such a browser, and the reason the recorder
    // is a convenience rather than a last resort. GIF and APNG are ours to
    // encode, so they are always there; WebP needs the browser's own encoder and
    // WebKit does not offer one, which is degrade.spec.js's territory, not this
    // test's.
    for (const id of ["gif", "apng"])
      expect(r.all.some((f) => f.id === id), `${id} missing`).toBe(true);
    expect(r.all.filter((f) => !f.recorder).length).toBeGreaterThanOrEqual(2);
    // And nothing offline-coded is offered, since nothing can encode.
    expect(r.all.filter((f) => f.kind === "ebml" || f.kind === "iso")).toEqual([]);
  });

test("with a VideoEncoder present, no recorder entry is offered", async ({ page }) => {
  await open(page, { withEncoder: true });
  const r = await page.evaluate(() => ({
    recorders: FORMATS.filter((f) => f.recorder).map((f) => f.id),
    coded: FORMATS.filter((f) => f.kind === "ebml" || f.kind === "iso").length,
  }));

  // The other half of the claim: this is a fallback, not an alternative.
  expect(r.recorders).toEqual([]);
  expect(r.coded).toBeGreaterThan(0);
});

// --- what it produces ------------------------------------------------------

test("a recorded clip is produced and passes verification", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async (h) => {
    eval(h); await ready();
    const fmt = FORMATS.find((f) => f.recorder);
    const { g, W, H } = dims();
    const said = [];
    const t0 = performance.now();
    const blob = await exportRecorder(fmt, W, H, g, S.plan, (t) => said.push(t), renderView(S.plan));
    const took = performance.now() - t0;
    const check = await verifyBlob(blob, "video", 0);
    return { size: blob.size, type: blob.type, mime: fmt.mime, took,
             check, saidRecording: said.some((t) => t.startsWith("Recording")) };
  }, HELPERS);

  expect(r.size).toBeGreaterThan(0);
  expect(r.type).toContain(r.mime.split(";")[0]);
  // #41 added this check and it had never run against a recorder blob.
  expect(r.check.ok, `verifyBlob refused the recording: ${r.check.reason}`).toBe(true);
  expect(r.saidRecording).toBe(true);
  // It really is real time: one loop of a 400 ms plan cannot come back instantly.
  expect(r.took).toBeGreaterThan(250);
});

test("cancelling a recording stops it and tears the capture stream down",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await ready();

      // captureStream is a DOM method, so it can be watched from out here; the
      // stream it hands back is the thing that must not be left running.
      const real = HTMLCanvasElement.prototype.captureStream;
      const streams = [];
      HTMLCanvasElement.prototype.captureStream = function (...a) {
        const s = real.apply(this, a); streams.push(s); return s;
      };

      const fmt = FORMATS.find((f) => f.recorder);
      const { g, W, H } = dims();
      S.loops = 20;                        // long enough to interrupt
      let outcome = "resolved", took = 0;
      try {
        const t0 = performance.now();
        const p = exportRecorder(fmt, W, H, g, S.plan, () => {}, renderView(S.plan));
        setTimeout(requestCancel, 150);
        await p;
        took = performance.now() - t0;
      } catch (e) {
        took = -1;
        outcome = e && e.cancelled ? "cancelled" : "threw: " + (e && e.message);
      } finally {
        HTMLCanvasElement.prototype.captureStream = real;
        renderFinished();
      }

      return { outcome, streams: streams.length,
               tracks: streams.flatMap((s) => s.getTracks().map((t) => t.readyState)) };
    }, HELPERS);

    // #45 added the teardown and it had never run. This is the path where
    // cancelling matters most: it is the only export that takes as long as the
    // clip, so a recording left running costs real time and a live capture.
    expect(r.outcome).toBe("cancelled");
    expect(r.streams).toBe(1);
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.tracks.every((s) => s === "ended"),
      `capture tracks still live: ${r.tracks}`).toBe(true);
  });

test("the recording offered after a failed mux is verified too", async ({ page }) => {
  // #41's claim, never exercised: when a coded mux fails verification the
  // recorder substitutes for it -- and the substitute is checked before being
  // offered, or the fallback would hand over a file already known to be broken.
  // Both are broken here, so the only correct outcome is an error.
  await page.addInitScript(() => {
    const Real = window.MediaRecorder;
    window.MediaRecorder = class {
      constructor(){ this.state = "inactive"; }
      static isTypeSupported(m){ return Real ? Real.isTypeSupported(m) : true; }
      start(){ this.state = "recording";
        setTimeout(() => this.ondataavailable &&
          this.ondataavailable({ data: new Blob([new Uint8Array([1,2,3,4])]) }), 10); }
      stop(){ this.state = "inactive"; this.onstop && this.onstop(); }
    };
  });
  await open(page, { withEncoder: true });

  const r = await page.evaluate(async (h) => {
    eval(h); await ready();
    // Not AVIF: it has its own failure message and never reaches the recorder
    // substitute, which is the branch under test.
    const coded = FORMATS.find((f) => (f.kind === "ebml" || f.kind === "iso") && !f.avif);
    const original = EXPORTERS.coded;
    EXPORTERS.coded = async () => new Blob([new Uint8Array([9,9,9,9])], { type: "video/webm" });
    try {
      document.querySelector("#fmt").value = coded.id;
      document.querySelector("#fmt").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#out").innerHTML = "";
      document.querySelector("#render").click();
      const t0 = performance.now();
      while (performance.now() - t0 < 25000) {
        await new Promise((res) => setTimeout(res, 50));
        if (!document.querySelector("#render").disabled &&
            document.querySelector("#out").innerHTML) break;
      }
      const el = document.querySelector("#out");
      return { warn: el.querySelector(".warn") ? el.querySelector(".warn").textContent : null,
               download: !!el.querySelector("a.dl") };
    } finally { EXPORTERS.coded = original; }
  }, HELPERS);

  expect(r.download, "a file known to be broken was offered").toBe(false);
  expect(r.warn).toContain("Neither the muxed file nor the real-time recording");
});
