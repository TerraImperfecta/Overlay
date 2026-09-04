// The GIF decoder against input it should refuse (#55).
//
// Two of these used to freeze the tab rather than report a bad file. The cause
// was the length-prefixed sub-block walk, which had no bound: past the end of
// the buffer d[p] is undefined, `p += 1 + undefined` makes p NaN, d[NaN] is
// undefined, and the loop runs for ever.
//
// The decoder is hand-written and reads whatever file a user drags in. A frozen
// tab is not only an inconvenience -- it also takes the other source they had
// already loaded, with no way back but a reload.
//
// The inputs are derived from a committed fixture rather than being committed
// themselves. "Truncated to half of 05-subrect.gif" says what it is; a binary
// blob with the same bytes does not, and corpus/ keeps meaning "valid GIFs that
// exercise a decode path".

const { test, expect } = require("./fixtures");

const MANGLE = `
async function mangled(which){
  const buf = new Uint8Array(await (await fetch("/corpus/05-subrect.gif")).arrayBuffer());
  const copy = () => buf.slice();
  const cases = {
    "truncated to half":      () => buf.slice(0, Math.floor(buf.length * 0.5)),
    "truncated to a tenth":   () => buf.slice(0, Math.floor(buf.length * 0.1)),
    "header only":            () => buf.slice(0, 13),
    "corrupt mid-stream":     () => { const b = copy();
                                      for (let i = 60; i < Math.min(120, b.length); i++) b[i] ^= 0xff;
                                      return b; },
    "trailer removed":        () => buf.slice(0, buf.length - 1),
    "absurd dimensions":      () => { const b = copy();
                                      b[6]=0xff; b[7]=0xff; b[8]=0xff; b[9]=0xff; return b; },
    "zero dimensions":        () => { const b = copy();
                                      b[6]=0; b[7]=0; b[8]=0; b[9]=0; return b; },
    "plausible but enormous": () => { const b = copy();
                                      b[6]=0x00; b[7]=0x40; b[8]=0x00; b[9]=0x40; return b; },
    "empty":                  () => new Uint8Array(0),
    "not a gif":              () => new TextEncoder().encode("this is plainly not a gif"),
  };
  const bytes = cases[which]();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

async function decode(which){
  const ab = await mangled(which);
  try {
    const gif = parseGIF(ab);
    const flat = flattenGIF(gif);
    return {ok: true, frames: flat.length, w: gif.width, h: gif.height};
  } catch (e) {
    return {error: e.message};
  }
}
`;

// Every one of these must finish. The assertion that matters most is simply
// that the test returns at all -- a hang shows up as a timeout naming the input.
const MUST_REFUSE = [
  "truncated to half", "truncated to a tenth", "header only", "corrupt mid-stream",
  "absurd dimensions", "zero dimensions", "plausible but enormous", "empty", "not a gif",
];

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof parseGIF === "function");
});

// An empty collection here would assert nothing at all.
expect(MUST_REFUSE.length).toBeGreaterThan(0);
for (const which of MUST_REFUSE) {
  test(`refuses "${which}" without hanging`, async ({ page }) => {
    test.setTimeout(15000);
    const r = await page.evaluate(async ({ helpers, w }) => {
      eval(helpers);
      return await decode(w);
    }, { helpers: MANGLE, w: which });

    expect(r.error, `"${which}" was accepted: ${JSON.stringify(r)}`).toBeTruthy();
    // A message a person can act on, not a stack trace or an internal name.
    expect(r.error).toMatch(/GIF/i);
    expect(r.error.length).toBeLessThan(120);
  });
}

test("a missing trailer is still readable", async ({ page }) => {
  // The bounds must not turn a merely untidy file into a rejected one: the
  // final 0x3B is optional in practice and every frame before it is intact.
  const r = await page.evaluate(async (helpers) => {
    eval(helpers);
    return await decode("trailer removed");
  }, MANGLE);

  expect(r.ok).toBe(true);
  expect(r.frames).toBe(4);
  expect(r.w).toBe(32);
});

test("oversized dimensions are refused before anything is allocated",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      // 16384 square is 268 megapixels: one frame is a gigabyte, and it does
      // not throw -- it allocates, slowly. That is the dangerous case, more so
      // than 65535 square, which at 17GB fails immediately.
      const before = performance.now();
      const out = await decode("plausible but enormous");
      return { ...out, ms: Math.round(performance.now() - before) };
    }, MANGLE);

    expect(r.error).toBeTruthy();
    expect(r.error).toContain("too large");
    // Refused on the header, so it cannot have spent time on a buffer.
    expect(r.ms).toBeLessThan(1000);
  });

test("a frame declared outside the canvas is clipped, not fatal", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const buf = new Uint8Array(await (await fetch("/corpus/05-subrect.gif")).arrayBuffer());
    const b = buf.slice();
    // Find the first image descriptor and push its origin far off the canvas.
    for (let i = 13; i < b.length - 9; i++) {
      if (b[i] === 0x2C) { b[i+1] = 0xf0; b[i+2] = 0xff; b[i+3] = 0xf0; b[i+4] = 0xff; break; }
    }
    try {
      const gif = parseGIF(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      const flat = flattenGIF(gif);
      return { ok: true, frames: flat.length, w: gif.width, h: gif.height };
    } catch (e) { return { error: e.message }; }
  });

  // flattenGIF clips per-pixel, so this decodes to something rather than
  // throwing -- but either outcome is legitimate and the decoder is free to
  // change its mind. What is not legitimate is hanging, or returning something
  // that is neither.
  //
  // `expect(r.error || r.ok).toBeTruthy()` used to stand here, which was no
  // assertion at all: r is one shape or the other, so it was always truthy.
  // Both branches assert now, so whichever the decoder takes is checked.
  if (r.ok) {
    expect(r.frames).toBeGreaterThan(0);
    // Clipped, not resized: the canvas is still the one the header declared.
    expect(r.w).toBe(32);
    expect(r.h).toBe(32);
  } else {
    expect(r.error).toMatch(/GIF/i);
    expect(r.error.length).toBeLessThan(120);
  }
});

test("a bad file dropped on a loaded slot leaves the good source alone",
  async ({ page }) => {
    const r = await page.evaluate(async (helpers) => {
      eval(helpers);
      async function li(i, n) {
        const bufr = await (await fetch("/corpus/" + n)).arrayBuffer();
        const src = await loadSource(new File([bufr], n, { type: "image/gif" }), () => {});
        if (S.src[i]) disposeSource(i);
        S.src[i] = src;
        renderSlot(i);
      }
      await li(0, "05-subrect.gif");
      const good = S.src[0];
      const goodBitmaps = good.frames.map((f) => f.bitmap);

      // Through the drop handler, as a user would, with a file that used to hang.
      const ab = await mangled("corrupt mid-stream");
      const dt = new DataTransfer();
      dt.items.add(new File([ab], "broken.gif", { type: "image/gif" }));
      const slot = document.querySelector('.slot[data-i="0"]');
      slot.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));

      const t0 = performance.now();
      while (performance.now() - t0 < 10000) {
        await new Promise((res) => setTimeout(res, 20));
        const meta = slot.querySelector(".meta");
        if (meta && !/Decoding/.test(meta.textContent)) break;
      }
      const meta = slot.querySelector(".meta");
      return {
        sameSource: S.src[0] === good,
        stillOpen: goodBitmaps.every((b) => b.width > 0),
        isError: !!slot.querySelector(".meta.warn"),
        message: meta ? meta.textContent : "",
        thumbs: slot.querySelectorAll(".thumb").length,
      };
    }, MANGLE);

    // #26's invariant, now under an input that used to freeze the page instead.
    expect(r.sameSource).toBe(true);
    expect(r.stillOpen).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.thumbs).toBe(1);
    expect(r.message).toMatch(/GIF/i);
  });
