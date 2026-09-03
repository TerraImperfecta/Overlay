// verifyBlob covers every output format, not just the coded ones (issue #38).
//
// PLAN.md section 3 says output is verified before it is offered, and that this
// is not overhead to be removed. It was only ever true of the coded branch --
// GIF, WebP and APNG shipped unchecked, including APNG, whose pixel-(0,0) alpha
// nudge exists because a real corruption bug was hit once.
//
// These tests do two things: confirm good output passes, and confirm that
// deliberately broken output FAILS. The second is the one that matters. A
// verifier that never rejects anything is indistinguishable from no verifier.

const { test, expect } = require("@playwright/test");

const STILL_FORMATS = ["gif", "webp", "apng"];

async function loadSources(page) {
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
    return { count: S.plan.count, delaysMs: S.plan.delaysMs };
  });
}

async function exportOne(page, id) {
  return page.evaluate(async (fid) => {
    const f = FORMATS.find((x) => x.id === fid);
    const plan = S.plan, g = geometry();
    const W = Math.max(2, Math.round(g.w * S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h * S.outScale) & ~1);
    const say = () => {};
    let blob;
    if (f.kind === "gif") blob = await exportGIF(W, H, g, plan, say);
    else if (f.kind === "webp") blob = await exportWebP(W, H, g, plan, say);
    else if (f.kind === "apng") blob = await exportAPNG(W, H, g, plan, say);
    else blob = await exportCoded(f, W, H, g, plan, say);
    window.__blob = blob;                       // kept for the corruption tests
    return { bytes: blob.size, type: blob.type };
  }, id);
}

test.describe("verifyBlob covers the still formats", () => {
  for (const id of STILL_FORMATS) {
    test(`${id}: good output passes, with the right frame count`, async ({ page }) => {
      const plan = await loadSources(page);
      await exportOne(page, id);
      const res = await page.evaluate(
        async ({ kind, expect: n }) => await verifyBlob(window.__blob, kind, n),
        { kind: id, expect: plan.count }
      );
      expect(res.ok).toBe(true);
      expect(res.frames).toBe(plan.count);
    });

    test(`${id}: a wrong frame count is rejected`, async ({ page }) => {
      const plan = await loadSources(page);
      await exportOne(page, id);
      // The file is fine; the expectation is not. This is the assertion that
      // catches a muxer dropping or duplicating a frame.
      const res = await page.evaluate(
        async ({ kind, expect: n }) => await verifyBlob(window.__blob, kind, n),
        { kind: id, expect: plan.count + 1 }
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toContain(`decoded ${plan.count} frames instead of ${plan.count + 1}`);
    });

    test(`${id}: truncated output is rejected`, async ({ page }) => {
      const plan = await loadSources(page);
      await exportOne(page, id);
      // Truncation is where the frame count earns its place. GIF and APNG
      // degrade gracefully -- a partial file still decodes frame 0 quite
      // happily, so a decodability check alone passes it. Only the count
      // notices that frames went missing. (WebP does fail outright, but
      // relying on that would leave the other two unprotected.)
      const res = await page.evaluate(async ({ kind, expect: n }) => {
        const full = new Uint8Array(await window.__blob.arrayBuffer());
        const cut = new Blob([full.slice(0, Math.floor(full.length * 0.4))],
                             { type: window.__blob.type });
        return await verifyBlob(cut, kind, n);
      }, { kind: id, expect: plan.count });
      expect(res.ok).toBe(false);
    });
  }
});

test("an unverifiable file is not treated as a bad one", async ({ page }) => {
  await loadSources(page);
  await exportOne(page, "gif");
  // Some browsers have no ImageDecoder at all. verifyBlob must not fail closed
  // there -- "we cannot check this" is not the same as "this is broken", and
  // failing closed would make GIF unexportable on those browsers.
  const res = await page.evaluate(async () => {
    const real = window.ImageDecoder;
    try {
      delete window.ImageDecoder;
      return await verifyBlob(window.__blob, "gif", 999);
    } finally {
      window.ImageDecoder = real;
    }
  });
  expect(res.ok).toBe(true);
  expect(res.reason).toBe("unverified");
});

test("render() surfaces a verification failure instead of offering the file", async ({ page }) => {
  await loadSources(page);
  // Break the WebP muxer's output, then drive the real UI and confirm the user
  // is told rather than handed a broken download.
  const out = await page.evaluate(async () => {
    const original = window.exportWebP;
    window.exportWebP = async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" });
    try {
      document.querySelector("#fmt").value = "webp";
      document.querySelector("#fmt").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#out").innerHTML = "";
      document.querySelector("#render").click();
      const t0 = performance.now();
      while (performance.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 50));
        if (!document.querySelector("#render").disabled &&
            document.querySelector("#out").innerHTML) break;
      }
      const el = document.querySelector("#out");
      return { html: el.innerHTML, download: !!el.querySelector("a.dl"),
               warn: el.querySelector(".warn") ? el.querySelector(".warn").textContent : null };
    } finally {
      window.exportWebP = original;
    }
  });
  expect(out.download).toBe(false);
  expect(out.warn).toContain("Couldn't render");
});

// Verification now runs on formats it never touched before, so the happy path
// needs a guard: a check that rejects good output would be worse than no check.
// This also pins #17's result -- every format the browser offers renders end to
// end and is actually offered for download.
test("every offered format renders and is offered for download", async ({ page }) => {
  const plan = await loadSources(page);
  const results = await page.evaluate(async () => {
    const sel = document.querySelector("#fmt"), btn = document.querySelector("#render");
    const out = document.querySelector("#out"), rows = [];
    for (const id of [...sel.options].map((o) => o.value)) {
      sel.value = id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      out.innerHTML = "";
      btn.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 50));
        if (!btn.disabled && out.innerHTML) break;
      }
      const a = out.querySelector("a.dl");
      rows.push({
        id,
        download: !!a,
        filename: a ? a.getAttribute("download") : null,
        error: out.querySelector(".warn") ? out.querySelector(".warn").textContent : null,
      });
    }
    return rows;
  });

  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.error, `${r.id} reported: ${r.error}`).toBeNull();
    expect(r.download, `${r.id} offered no download`).toBe(true);
    expect(r.filename).toMatch(/^overlay\./);
  }
  expect(plan.count).toBeGreaterThan(1);
});
