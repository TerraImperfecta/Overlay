#!/usr/bin/env node
// Check the deployed site, not a local copy of it (#90).
//
// Everything else here is verified against test/serve.js on localhost, which
// shares nothing with GitHub Pages but the bytes: content types, redirects, the
// CNAME and TLS, and whether a deploy actually landed are all outside what any
// local test can see. #88 is the standing example -- a 404 the whole suite
// missed and three lines against production found immediately.
//
//   npm run verify:deployed                  # overlay.immanuelqrw.dev
//   npm run verify:deployed -- http://localhost:8080
//
// Exits non-zero on the first thing that is wrong, so it can gate a deploy.

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const ORIGIN = (process.argv[2] || "https://overlay.immanuelqrw.dev").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..");
const WAIT_MS = Number(process.env.VERIFY_WAIT_MS || 300000);   // Pages can lag

/* Every file the page itself needs. corpus/ ships too but only the tests read
   it, so a missing corpus is not a broken site. */
const REQUIRED = ["index.html", "styles.css",
  ...fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js")).sort()
      .map((f) => `js/${f}`)];

const TYPE = { ".html": /text\/html/, ".css": /text\/css/, ".js": /javascript/ };

const ok = [];
let failed = 0;
const pass = (m) => ok.push(`  ok    ${m}`);
const fail = (m) => { failed++; ok.push(`  FAIL  ${m}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  return { r, body: Buffer.from(await r.arrayBuffer()) };
}

/* The deployment is current when every file matches the checkout byte for byte.
   That needs no version marker in the page, and it catches a half-applied
   publish as well as a stale one. */
async function waitForCurrent() {
  const deadline = Date.now() + WAIT_MS;
  let stale = [];
  for (let attempt = 1; ; attempt++) {
    stale = [];
    for (const rel of REQUIRED) {
      const want = fs.readFileSync(path.join(ROOT, rel));
      try {
        const { r, body } = await fetchText(`${ORIGIN}/${rel}`);
        if (!r.ok) { stale.push(`${rel} (${r.status})`); continue; }
        if (!body.equals(want)) stale.push(`${rel} (${body.length} vs ${want.length} bytes)`);
      } catch (e) { stale.push(`${rel} (${e.message})`); }
    }
    if (!stale.length) return attempt;
    if (Date.now() > deadline) throw new Error(
      `the deployed copy never matched the checkout:\n    ${stale.join("\n    ")}`);
    process.stdout.write(`  waiting for the deploy to land (${stale.length} file(s) behind)…\n`);
    await sleep(15000);
  }
}

(async () => {
  console.log(`Verifying ${ORIGIN}\n`);

  // ---- 1. the deployment is complete and current --------------------------
  try {
    const attempts = await waitForCurrent();
    pass(`all ${REQUIRED.length} files match the checkout` +
         (attempts > 1 ? ` (after ${attempts} attempts)` : ""));
  } catch (e) { fail(e.message); }

  // ---- 2. served as the right type ---------------------------------------
  for (const rel of REQUIRED.filter((f) => !f.startsWith("js/") || f === "js/main.js")) {
    const ext = path.extname(rel);
    try {
      const { r } = await fetchText(`${ORIGIN}/${rel}`);
      const ct = r.headers.get("content-type") || "";
      if (TYPE[ext].test(ct)) pass(`${rel} is ${ct.split(";")[0]}`);
      else fail(`${rel} served as "${ct}" — a module served as anything but ` +
                `JavaScript is refused by the browser, silently`);
    } catch (e) { fail(`${rel}: ${e.message}`); }
  }

  // ---- 3. transport -------------------------------------------------------
  if (ORIGIN.startsWith("https://")) {
    try {
      const r = await fetch(ORIGIN.replace("https://", "http://"), { redirect: "manual" });
      const loc = r.headers.get("location") || "";
      if (r.status >= 300 && r.status < 400 && loc.startsWith("https://"))
        pass(`http redirects to ${loc}`);
      else fail(`http did not redirect to https (${r.status} ${loc})`);
    } catch (e) { fail(`http redirect: ${e.message}`); }
  }

  // ---- 4. it actually works ----------------------------------------------
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [], bad = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (!r.ok() && !r.url().startsWith("data:")) bad.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });

    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#fmt")?.options.length > 0,
                               null, { timeout: 20000 });

    const r = await page.evaluate(async (origin) => {
      const ns = await import(`${origin}/js/main.js`);
      async function li(i, name) {
        const buf = await (await fetch(`${origin}/corpus/${name}`)).arrayBuffer();
        const s = await ns.loadSource(new File([buf], name, { type: "image/gif" }), () => {});
        if (ns.S.src[i]) ns.disposeSource(i);
        ns.S.src[i] = s; ns.renderSlot(i);
      }
      await li(0, "05-subrect.gif"); await li(1, "01-interlaced.gif");
      ns.replan();
      const g = ns.geometry();
      const W = Math.max(2, Math.round(g.w * ns.S.outScale) & ~1);
      const H = Math.max(2, Math.round(g.h * ns.S.outScale) & ~1);
      const blob = await ns.exportGIF(W, H, g, ns.S.plan, () => {}, ns.renderView(ns.S.plan));
      const check = await ns.verifyBlob(blob, "gif", ns.S.plan.count);
      return { formats: ns.FORMATS.length, frames: ns.S.plan.count,
               bytes: blob.size, verified: check.ok, reason: check.reason,
               leaked: ["S", "geometry", "exportGIF"].filter((n) => n in globalThis),
               styled: getComputedStyle(document.body).backgroundColor };
    }, ORIGIN);

    errors.length ? fail(`page errors: ${errors.join(" | ")}`) : pass("no page errors");
    bad.length ? fail(`failed requests: ${bad.join(", ")}`) : pass("no failed requests");
    r.formats > 0 ? pass(`${r.formats} formats offered`) : fail("no formats offered");
    r.styled === "rgb(21, 24, 39)" ? pass("stylesheet applied")
                                   : fail(`body background is ${r.styled} — stylesheet missing?`);
    r.leaked.length ? fail(`app names leaked to window: ${r.leaked}`)
                    : pass("modules keep their names to themselves");
    r.verified ? pass(`merged ${r.frames} frames and exported a verified ${r.bytes}-byte GIF`)
               : fail(`the exported GIF did not verify: ${r.reason}`);
  } catch (e) {
    fail(`driving the site: ${e.message}`);
  } finally { await browser.close(); }

  console.log(ok.join("\n"));
  console.log(failed ? `\n${failed} check(s) failed` : "\nthe deployed site is healthy");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
