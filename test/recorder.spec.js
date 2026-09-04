// MediaRecorder after #59 removed it as a format.
//
// It used to be offered whenever no VideoEncoder codec existed, labelled
// "(real time)". #59 forced that branch for the first time -- no engine lacks a
// VideoEncoder, so it had never run -- and measured what it produced: against a
// plan with boundaries of 100/48/52/96/30 ms, a recording came back flat at
// ~67 ms, a uniform resample at the capture rate drifting up to 30 ms. That is
// the drift the tool exists to prevent, so the entries are gone.
//
// What survives is the repair in render(): when a coded mux produces something
// that will not play, a real-time recording is offered instead, with a warning.
// The choice there is not between a worse file and a better one but between a
// worse file and none.
//
// So these tests are in two halves: the fallback must never be offered, and the
// repair must still work.

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
  S.sync = "auto"; S.outScale = 1;
  replan();
}
function dims(){
  const g = geometry();
  return { g, W: Math.max(2, Math.round(g.w*S.outScale) & ~1),
              H: Math.max(2, Math.round(g.h*S.outScale) & ~1) };
}
/* The mime the repair path picks, chosen the same way it does. */
function repairMime(){
  return ["video/webm;codecs=vp9","video/webm;codecs=vp8"]
    .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
}
`;

async function open(page, { withEncoder = true } = {}) {
  if (!withEncoder) await page.addInitScript(NO_ENCODER);
  await page.goto("/index.html");
  await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);
}

// --- never offered ---------------------------------------------------------

test("no recorder format is offered, even with no VideoEncoder at all",
  async ({ page }) => {
    await open(page, { withEncoder: false });
    const r = await page.evaluate(() => ({
      hasVideoEncoder: typeof VideoEncoder !== "undefined",
      hasMediaRecorder: typeof MediaRecorder !== "undefined",
      ids: FORMATS.map((f) => f.id),
      labels: FORMATS.map((f) => f.label),
      kinds: [...new Set(FORMATS.map((f) => f.kind))],
    }));

    // The condition that used to add them: no codec, but a MediaRecorder to
    // hand. If this ever stops holding the test proves nothing.
    expect(r.hasVideoEncoder).toBe(false);
    expect(r.hasMediaRecorder).toBe(true);

    expect(r.ids.filter((id) => id.startsWith("rec:"))).toEqual([]);
    expect(r.kinds).not.toContain("recorder");
    expect(r.labels.join(" ")).not.toContain("real time");

    // And nobody is left without an export. GIF and APNG need no browser codec,
    // and both keep exact frame timing, which is the whole argument for
    // dropping the recorder rather than labelling it more loudly.
    for (const id of ["gif", "apng"])
      expect(r.ids, `${id} missing`).toContain(id);
  });

test("the loop control went with them", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => ({
    loopsCtl: document.querySelectorAll("#loopsCtl").length,
    loopsInput: document.querySelectorAll("#loops").length,
    onState: "loops" in S,
  }));

  // It only ever appeared for a recorder format, and the repair records the
  // plan exactly once.
  expect(r.loopsCtl).toBe(0);
  expect(r.loopsInput).toBe(0);
  expect(r.onState).toBe(false);
});

// --- but the repair still works --------------------------------------------

test("a recording is still produced, verifiable, and one loop long",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await ready();
      const { g, W, H } = dims();
      const said = [];
      const t0 = performance.now();
      const blob = await exportRecorder({ mime: repairMime() }, W, H, g, S.plan,
                                        (t) => said.push(t), renderView(S.plan));
      const took = performance.now() - t0;
      return { size: blob.size, check: await verifyBlob(blob, "video"),
               took, outDur: S.plan.outDur,
               saidRecording: said.some((t) => t.startsWith("Recording")) };
    }, HELPERS);

    expect(r.size).toBeGreaterThan(0);
    expect(r.check.ok, `verifyBlob refused the recording: ${r.check.reason}`).toBe(true);
    expect(r.saidRecording).toBe(true);
    // One loop of the plan, not the three the removed control used to default
    // to: real time, so the wall clock is the assertion.
    expect(r.took).toBeGreaterThan(r.outDur * 0.6);
    expect(r.took).toBeLessThan(r.outDur * 2.5);
  });

test("cancelling a recording stops it and tears the capture stream down",
  async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (h) => {
      eval(h); await ready();
      const real = HTMLCanvasElement.prototype.captureStream;
      const streams = [];
      HTMLCanvasElement.prototype.captureStream = function (...a) {
        const s = real.apply(this, a); streams.push(s); return s;
      };
      // A long plan, so there is a recording to interrupt.
      const plan = Object.assign({}, S.plan, { outDur: 20000 });
      const { g, W, H } = dims();
      let outcome = "resolved";
      try {
        const p = exportRecorder({ mime: repairMime() }, W, H, g, plan, () => {},
                                 renderView(S.plan));
        setTimeout(requestCancel, 150);
        await p;
      } catch (e) {
        outcome = e && e.cancelled ? "cancelled" : "threw: " + (e && e.message);
      } finally {
        HTMLCanvasElement.prototype.captureStream = real;
        renderFinished();
      }
      return { outcome, streams: streams.length,
               tracks: streams.flatMap((s) => s.getTracks().map((t) => t.readyState)) };
    }, HELPERS);

    // This is the only export that takes as long as the clip, so a recording
    // left running costs real time and a live capture.
    expect(r.outcome).toBe("cancelled");
    expect(r.streams).toBe(1);
    expect(r.tracks.every((s) => s === "ended"),
      `capture tracks still live: ${r.tracks}`).toBe(true);
  });

test("the recording offered after a failed mux is verified too, and says what it is",
  async ({ page }) => {
    // Both are broken here -- the mux by substitution, the recorder by a stub
    // that emits four junk bytes -- so the only correct outcome is an error
    // rather than a file already known not to play.
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
    await open(page);

    const r = await page.evaluate(async (h) => {
      eval(h); await ready();
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
