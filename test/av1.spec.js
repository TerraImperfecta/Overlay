// av1ConfigRecord's sequence-header parser (issue #21).
//
// PLAN.md section 4 assumed this code was dormant -- "only exercised when
// Chrome's AV1 encoder omits decoderConfig.description... so the bug can hide".
// #17 found the reverse: Chrome 148 never supplies a description, so the parser
// runs on every AV1 export and its output is load-bearing for AVIF, MP4 · AV1
// and WebM · AV1 alike.
//
// That makes the real risk narrower and sharper. Chrome's encoder emits one
// shape of sequence header, so the branches it never takes -- timing_info,
// decoder_model_info, multiple operating points -- are the ones most likely to
// be wrong, and no amount of re-running the app will touch them.
//
// So these tests build headers by hand, to spec, and feed them in. `bits` (how
// far the reader got) is asserted alongside the field values: a parser can read
// the first operating point correctly while being hopelessly out of step by the
// end of the header, and only the bit count notices.

const { test, expect } = require("./fixtures");

// A writer for AV1's bit syntax, so headers can be built field by field.
const WRITER = `
class W {
  constructor(){ this.bits = []; }
  f(v, n){ for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / Math.pow(2, i)) % 2); return this; }
  // uvlc: z zeros, a 1, then z bits holding value - (2^z - 1).
  uvlc(v){
    let z = 0;
    while (Math.pow(2, z + 1) - 1 <= v) z++;
    this.f(0, z).f(1, 1);
    if (z) this.f(v - (Math.pow(2, z) - 1), z);
    return this;
  }
  get length(){ return this.bits.length; }
  payload(){
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
    return bytes;
  }
  // Wrap as OBU_SEQUENCE_HEADER (type 1) with a size field.
  obu(){
    const p = this.payload();
    const size = [];
    let n = p.length;
    do { let b = n & 0x7F; n >>= 7; if (n) b |= 0x80; size.push(b); } while (n);
    return new Uint8Array([0x0A, ...size, ...p]);
  }
}
`;

// Build a sequence header from a description of which branches to take.
const BUILD = `
function buildSeqHeader(o){
  const w = new W();
  w.f(o.profile ?? 0, 3);
  w.f(o.stillPicture ?? 0, 1);
  w.f(o.reduced ?? 0, 1);
  if (o.reduced){
    w.f(o.level ?? 0, 5);
    return w;
  }
  const timing = o.timing ? 1 : 0;
  w.f(timing, 1);
  let delayBits = 0;
  if (timing){
    w.f(o.timing.numUnits ?? 1000, 32);
    w.f(o.timing.timeScale ?? 30000, 32);
    const equal = o.timing.equalPictureInterval ? 1 : 0;
    w.f(equal, 1);
    if (equal) w.uvlc(o.timing.ticksMinus1 ?? 0);
    const dm = o.decoderModel ? 1 : 0;
    w.f(dm, 1);
    if (dm){
      delayBits = (o.decoderModel.bufferDelayLengthMinus1 ?? 7) + 1;
      w.f(delayBits - 1, 5);
      w.f(o.decoderModel.numUnitsInDecodingTick ?? 500, 32);
      w.f(o.decoderModel.bufferRemovalTimeLengthMinus1 ?? 3, 5);
      w.f(o.decoderModel.framePresentationTimeLengthMinus1 ?? 4, 5);
    }
  }
  const initialDelay = o.initialDisplayDelay ? 1 : 0;
  w.f(initialDelay, 1);
  const ops = o.operatingPoints;
  w.f(ops.length - 1, 5);
  for (const op of ops){
    w.f(op.idc ?? 0, 12);
    w.f(op.level, 5);
    if (op.level > 7) w.f(op.tier ?? 0, 1);
    if (o.decoderModel){
      const present = op.decoderModelPresent ? 1 : 0;
      w.f(present, 1);
      if (present){
        w.f(op.decoderBufferDelay ?? 1, delayBits);
        w.f(op.encoderBufferDelay ?? 2, delayBits);
        w.f(op.lowDelayMode ?? 0, 1);
      }
    }
    if (initialDelay){
      const present = op.initialDelayPresent ? 1 : 0;
      w.f(present, 1);
      if (present) w.f(op.initialDelayMinus1 ?? 0, 4);
    }
  }
  return w;
}
`;

// Reading a uvlc back out of one the writer produced. A function declaration,
// because `class W` belongs to the eval that declared it and is invisible to
// anything outside it.
const UVLC = `
function readUvlc(v){
  const w = new W().uvlc(v);
  const b = new Bits(w.payload());
  const got = b.uvlc();
  return { v, got, read: b.p, written: w.length };
}
function readRaw(bits){
  const bytes = new Uint8Array(Math.ceil(Math.max(bits.length, 1) / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
  const r = new Bits(bytes);
  let err = null, got = null;
  try { got = r.uvlc(); } catch (e) { err = e.message; }
  return { got, read: r.p, err };
}
`;

async function uvlc(page, fn) {
  return page.evaluate(({ writer, helper, body }) => {
    eval(writer + helper);
    return eval(body);
  }, { writer: WRITER, helper: UVLC, body: fn });
}

async function parse(page, spec) {
  return page.evaluate(
    ({ writer, build, o }) => {
      // One eval: a class declared in its own eval scope is invisible to a
      // function declared in a separate one.
      eval(writer + build);
      const w = buildSeqHeader(o);
      const parsed = parseSequenceHeader(w.obu());
      return { ...parsed, written: w.length };
    },
    { writer: WRITER, build: BUILD, o: spec }
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof parseSequenceHeader === "function");
});

test("reduced_still_picture_header: level only, tier implicitly 0", async ({ page }) => {
  const r = await parse(page, { profile: 0, stillPicture: 1, reduced: 1, level: 8 });
  expect(r.seqProfile).toBe(0);
  expect(r.levelIdx).toBe(8);
  expect(r.tier).toBe(0);
  expect(r.bits).toBe(r.written);
});

test("no timing info, one operating point, level below the tier threshold", async ({ page }) => {
  const r = await parse(page, { profile: 1, operatingPoints: [{ level: 5 }] });
  expect(r.seqProfile).toBe(1);
  expect(r.levelIdx).toBe(5);
  expect(r.tier).toBe(0);            // seq_level_idx <= 7 means no tier bit at all
  expect(r.bits).toBe(r.written);
});

test("level above 7 carries a tier bit", async ({ page }) => {
  const r = await parse(page, { profile: 2, operatingPoints: [{ level: 13, tier: 1 }] });
  expect(r.levelIdx).toBe(13);
  expect(r.tier).toBe(1);
  expect(r.bits).toBe(r.written);
});

test("timing_info without equal_picture_interval", async ({ page }) => {
  const r = await parse(page, {
    timing: { numUnits: 1001, timeScale: 60000, equalPictureInterval: 0 },
    operatingPoints: [{ level: 9, tier: 0 }],
  });
  expect(r.levelIdx).toBe(9);
  expect(r.bits).toBe(r.written);
});

test("timing_info with equal_picture_interval reads the uvlc", async ({ page }) => {
  // uvlc is variable-length, so a wrong read desynchronises everything after it.
  for (const ticks of [0, 1, 6, 100, 5000]) {
    const r = await parse(page, {
      timing: { equalPictureInterval: 1, ticksMinus1: ticks },
      operatingPoints: [{ level: 12, tier: 1 }],
    });
    expect(r.levelIdx, `ticks=${ticks}`).toBe(12);
    expect(r.tier, `ticks=${ticks}`).toBe(1);
    expect(r.bits, `ticks=${ticks}`).toBe(r.written);
  }
});

test("initial_display_delay is consumed, present or not", async ({ page }) => {
  const r = await parse(page, {
    initialDisplayDelay: 1,
    operatingPoints: [
      { level: 8, tier: 0, initialDelayPresent: 1, initialDelayMinus1: 9 },
      { level: 4, initialDelayPresent: 0 },
    ],
  });
  expect(r.levelIdx).toBe(8);
  expect(r.bits).toBe(r.written);
});

// The regression this issue produced.
//
// operating_parameters_info() is 2 * buffer_delay_length + 1 bits and follows
// decoder_model_present_for_this_op. The parser used to read the flag and skip
// the payload, which left every operating point after the first being read from
// the wrong bit offset. Operating point 0 still came out right -- its level and
// tier are read before the mistake -- so nothing downstream ever noticed.
test("decoder_model_info: operating_parameters_info is consumed", async ({ page }) => {
  for (const bufLen of [0, 7, 15, 31]) {
    const r = await parse(page, {
      profile: 0,
      timing: { equalPictureInterval: 1, ticksMinus1: 3 },
      decoderModel: { bufferDelayLengthMinus1: bufLen },
      operatingPoints: [
        { idc: 0x101, level: 13, tier: 1, decoderModelPresent: 1 },
        { idc: 0x202, level: 6, decoderModelPresent: 1 },
        { idc: 0x303, level: 9, tier: 0, decoderModelPresent: 0 },
      ],
    });
    expect(r.levelIdx, `bufLen=${bufLen}`).toBe(13);
    expect(r.tier, `bufLen=${bufLen}`).toBe(1);
    // The bit count is the assertion that matters: it is the only thing that
    // can tell a parser which read the whole header from one which merely got
    // the first operating point right.
    expect(r.bits, `bufLen=${bufLen}`).toBe(r.written);
  }
});

test("everything at once", async ({ page }) => {
  const r = await parse(page, {
    profile: 2,
    stillPicture: 0,
    timing: { numUnits: 1, timeScale: 90000, equalPictureInterval: 1, ticksMinus1: 42 },
    decoderModel: { bufferDelayLengthMinus1: 12, bufferRemovalTimeLengthMinus1: 9,
                    framePresentationTimeLengthMinus1: 11 },
    initialDisplayDelay: 1,
    operatingPoints: [
      { idc: 0xabc, level: 15, tier: 1, decoderModelPresent: 1, lowDelayMode: 1,
        initialDelayPresent: 1, initialDelayMinus1: 5 },
      { idc: 0x001, level: 2, decoderModelPresent: 0, initialDelayPresent: 1, initialDelayMinus1: 0 },
      { idc: 0x0ff, level: 10, tier: 0, decoderModelPresent: 1, initialDelayPresent: 0 },
    ],
  });
  expect(r.seqProfile).toBe(2);
  expect(r.levelIdx).toBe(15);
  expect(r.tier).toBe(1);
  expect(r.bits).toBe(r.written);
});

test("the record av1ConfigRecord emits is well formed", async ({ page }) => {
  const rec = await page.evaluate(({ writer, build }) => {
    eval(writer + build);
    const obu = buildSeqHeader({ profile: 1, operatingPoints: [{ level: 13, tier: 1 }] }).obu();
    return Array.from(av1ConfigRecord(null, obu).slice(0, 4));
  }, { writer: WRITER, build: BUILD });

  // AV1CodecConfigurationRecord:
  //   marker=1, version=1                         -> 0x81
  //   seq_profile(3) | seq_level_idx_0(5)
  //   seq_tier_0(1) | high_bitdepth | twelve_bit | monochrome
  //     | subsampling_x | subsampling_y | chroma_sample_position(2)
  //   reserved(3) | initial_presentation_delay_present(1) | delay_minus_one(4)
  expect(rec[0]).toBe(0x81);
  expect(rec[1] >> 5).toBe(1);            // seq_profile
  expect(rec[1] & 31).toBe(13);           // seq_level_idx_0
  expect(rec[2] >> 7).toBe(1);            // seq_tier_0
  expect(rec[2] & 0x7f).toBe(0x0c);       // 8-bit 4:2:0, not monochrome
  expect(rec[3]).toBe(0x00);
});

test("a description from the browser is passed through untouched", async ({ page }) => {
  // The branch Chrome 148 never takes. If a browser ever does supply
  // decoderConfig.description, it must win over anything we would parse.
  const same = await page.evaluate(() => {
    const desc = new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0xde, 0xad]);
    const out = av1ConfigRecord(desc, new Uint8Array([0]));
    return out === desc;
  });
  expect(same).toBe(true);
});

// --- uvlc (#57) ------------------------------------------------------------
//
// The value uvlc() returns is discarded today -- it is read once, for
// num_ticks_per_picture_minus_1, and thrown away. Only its effect on the bit
// position matters, which is precisely why it is worth testing directly: a
// wrong value is invisible until the day something reads it, and a wrong bit
// count desynchronises every field after it.

test("uvlc round-trips every leading-zero length it permits", async ({ page }) => {
  const rows = await uvlc(page, `
    (() => { const out = [];
      for (let z = 0; z <= 31; z++) out.push({ z, ...readUvlc(Math.pow(2, z) - 1) });
      return out; })()`);

  // An empty collection here would assert nothing at all.
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    // 2^z - 1 is the smallest value with z leading zeros, so the offset is the
    // whole of it and the value bits are all zero.
    expect(r.got, `z=${r.z} read back wrong`).toBe(r.v);
    expect(r.read, `z=${r.z} consumed the wrong number of bits`).toBe(r.written);
  }
});

test("uvlc does not overflow at 31 leading zeros", async ({ page }) => {
  // 1 << 31 is negative in JavaScript, so ((1<<z)-1) is -2147483649 here rather
  // than 2147483647. z > 31 bailed out, which left 31 permitted and wrong.
  const r = await uvlc(page, `readUvlc(2147483647)`);
  expect(r.got).toBe(2147483647);
  expect(r.got).toBeGreaterThan(0);
  expect(r.read).toBe(r.written);
});

test("uvlc reads the largest value the field can hold", async ({ page }) => {
  // 2^32 - 2: still 31 leading zeros, but every one of the 31 value bits set.
  const r = await uvlc(page, `readUvlc(4294967294)`);
  expect(r.got).toBe(4294967294);
  expect(r.read).toBe(r.written);
});

test("32 or more leading zeros is the maximum, not a silent zero", async ({ page }) => {
  // The spec: leadingZeros >= 32 returns 2^32 - 1, and no value bits follow.
  const r = await uvlc(page, `readRaw([...Array(32).fill(0), 1])`);
  expect(r.err).toBeNull();
  expect(r.got).toBe(4294967295);
  // The terminating 1 is still consumed; stopping short of it would leave every
  // later field being read one bit early.
  expect(r.read).toBe(33);
});

test("a uvlc that runs off the end of the header is refused, not looped on",
  async ({ page }) => {
    // f() returns 0 past the end of the buffer, so a reader looking for a 1 that
    // is not there never finds one. The old bail-out at 32 hid that; the bound
    // is now the buffer, and running out is treated as the malformed input it is.
    const r = await uvlc(page, `readRaw(Array(200).fill(0))`);
    expect(r.err).toBeTruthy();
    expect(r.err).toMatch(/AV1/i);
  });

test("a large tick count leaves the reader in step", async ({ page }) => {
  // The end-to-end version: the value is discarded, but if uvlc consumed the
  // wrong number of bits every field after it would be read from the wrong
  // offset -- which is the shape #42 had.
  const r = await parse(page, {
    profile: 0,
    timing: { numUnits: 1000, timeScale: 30000,
              equalPictureInterval: 1, ticksMinus1: 2147483647 },
    operatingPoints: [{ level: 13, tier: 1 }],
  });
  expect(r.levelIdx).toBe(13);
  expect(r.tier).toBe(1);
  expect(r.bits).toBe(r.written);
});
