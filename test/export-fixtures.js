#!/usr/bin/env node
// Drive the real application in a real browser, export every format it offers,
// and write the results to out/ for external validation.
//
//   npm run fixtures
//
// This exists for issue #18. verifyBlob() and ImageDecoder only prove that a
// decoder accepts a file; they say nothing about whether the container is
// well-formed or whether per-frame timing survived the mux. Answering that
// needs ffprobe, avifdec, webpinfo, pngcheck and gifsicle, which need files on
// disk -- so this produces them, alongside out/plan.json recording exactly what
// the timing was supposed to be.
//
// The sources are corpus GIFs, so a run is reproducible without hunting for
// input files, and the plan comes out with deliberately uneven frame delays: a
// constant frame rate would let a muxer be wrong about timing and still look
// right.

const { chromium } = require("@playwright/test");
const { exposeApp } = require("./fixtures");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const PORT = Number(process.env.PORT || 8932);
const BASE = `http://localhost:${PORT}`;

const BASE_GIF = "05-subrect.gif";   // 32x32, 4 frames, 400ms
const OVER_GIF = "06-delay-zero.gif"; // 16x16, 4 frames, 270ms
const OUT_SCALE = 8;                  // -> 256x256, a size an encoder meets in the wild

// `--stress` swaps in a long, constant-delay plan before exporting. Two things
// PLAN.md section 4 warns about cannot be reached by a short clip with uneven
// delays: stts run-length compression (nothing compresses when every delta
// differs) and the WebM cluster break at 30000ms, forced by int16 SimpleBlock
// relative timecodes. This plan is synthetic -- the UI would not produce it
// from these sources -- but a muxer cannot tell the difference.
const STRESS = process.argv.includes("--stress");
const STRESS_FRAMES = 55;
const STRESS_STEP = 800;              // 44 seconds, past two cluster breaks

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not come up at ${url}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const server = spawn("node", [path.join(__dirname, "serve.js"), String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const browser = await chromium.launch();

  try {
    await waitForServer(`${BASE}/index.html`);
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`${BASE}/index.html`);
    await exposeApp(page);
    await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0);

    const setup = await page.evaluate(async ({ baseGif, overGif, outScale,
                                               stress, stressFrames, stressStep }) => {
      async function loadInto(i, name) {
        const buf = await (await fetch("/corpus/" + name)).arrayBuffer();
        const src = await loadSource(new File([buf], name, { type: "image/gif" }), () => {});
        if (S.src[i]) disposeSource(i);
        S.src[i] = src;
      }
      await loadInto(0, baseGif);
      await loadInto(1, overGif);
      S.outScale = outScale;
      S.sync = "auto";
      replan();
      if (stress) {
        S.plan = Object.assign({}, S.plan, {
          count: stressFrames,
          times: Array.from({ length: stressFrames }, (_, i) => i * stressStep),
          delaysMs: Array(stressFrames).fill(stressStep),
          delaysCs: Array(stressFrames).fill(stressStep / 10),
          outDur: stressFrames * stressStep,
        });
      }
      const g = geometry();
      return {
        browser: navigator.userAgent,
        formats: FORMATS.map((f) => ({ id: f.id, ext: f.ext, kind: f.kind })),
        W: Math.max(2, Math.round(g.w * S.outScale) & ~1),
        H: Math.max(2, Math.round(g.h * S.outScale) & ~1),
        plan: {
          mode: S.plan.mode, count: S.plan.count, outDur: S.plan.outDur,
          delaysMs: S.plan.delaysMs, delaysCs: S.plan.delaysCs, times: S.plan.times,
          resampled: S.plan.resampled,
        },
      };
    }, { baseGif: BASE_GIF, overGif: OVER_GIF, outScale: OUT_SCALE,
         stress: STRESS, stressFrames: STRESS_FRAMES, stressStep: STRESS_STEP });

    if (STRESS) console.log(`MODE    : stress (synthetic ${STRESS_FRAMES}-frame, ${STRESS_STEP}ms plan)`);
    console.log(`browser : ${setup.browser}`);
    console.log(`output  : ${setup.W}x${setup.H}, ${setup.plan.count} frames, ${setup.plan.outDur}ms`);
    console.log(`delays  : [${setup.plan.delaysMs.join(", ")}] ms  (mode: ${setup.plan.mode})`);
    console.log(`formats : ${setup.formats.map((f) => f.id).join(", ")}\n`);

    const written = [];
    for (const fmt of setup.formats) {
      const res = await page.evaluate(async (id) => {
        const f = FORMATS.find((x) => x.id === id);
        const plan = S.plan, g = geometry();
        const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
        const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
        const say = () => {};
        try {
          let blob;
          if (f.kind === "gif") blob = await exportGIF(W, H, g, plan, say);
          else if (f.kind === "webp") blob = await exportWebP(W, H, g, plan, say);
          else if (f.kind === "apng") blob = await exportAPNG(W, H, g, plan, say);
          else blob = await exportCoded(f, W, H, g, plan, say);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return { ok: true, b64: btoa(bin), type: blob.type };
        } catch (e) {
          return { ok: false, error: (e && (e.message || e.name)) || String(e) };
        }
      }, fmt.id);

      if (!res.ok) {
        console.log(`${fmt.id.padEnd(10)} FAILED: ${res.error}`);
        written.push({ ...fmt, error: res.error });
        continue;
      }
      const file = `${STRESS ? "long-" : ""}${fmt.id}.${fmt.ext}`;
      const buf = Buffer.from(res.b64, "base64");
      fs.writeFileSync(path.join(OUT, file), buf);
      console.log(`${fmt.id.padEnd(10)} ${String(buf.length).padStart(7)} bytes -> out/${file}`);
      written.push({ ...fmt, file, bytes: buf.length, type: res.type });
    }

    fs.writeFileSync(
      path.join(OUT, STRESS ? "plan-long.json" : "plan.json"),
      JSON.stringify({ ...setup, written, pageErrors }, null, 1) + "\n"
    );
    console.log(`\nout/${STRESS ? "plan-long.json" : "plan.json"} written${pageErrors.length ? ` (page errors: ${pageErrors.length})` : ""}`);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
