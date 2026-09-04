/* =====================================================================
   ISOBMFF MUXER  →  MP4 and animated AVIF
   ===================================================================== */
export const cat = list => { let n = 0; for (const a of list) n += a.length;
  const o = new Uint8Array(n); let p = 0; for (const a of list){ o.set(a,p); p += a.length; } return o; };
export const s4  = s => Uint8Array.from([s.charCodeAt(0),s.charCodeAt(1),s.charCodeAt(2),s.charCodeAt(3)]);
export const U32 = v => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v>>>0); return a; };
export const U16 = v => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v & 0xFFFF); return a; };
export const U8A = arr => Uint8Array.from(arr);
export function box(type, ...parts){
  const body = cat(parts), out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(s4(type), 4); out.set(body, 8);
  return out;
}
export const fbox = (type, ver, flags, ...parts) =>
  box(type, U8A([ver, (flags>>16)&255, (flags>>8)&255, flags&255]), ...parts);
export const MATRIX = cat([U32(0x00010000),U32(0),U32(0),U32(0),U32(0x00010000),U32(0),
                    U32(0),U32(0),U32(0x40000000)]);

export class Bits {
  constructor(u8){ this.d = u8; this.p = 0; }
  f(n){ let v = 0; for (let i=0;i<n;i++){
    v = (v*2) + ((this.d[this.p>>3] >> (7-(this.p&7))) & 1); this.p++; } return v; }
  /* The offset is computed in floating point, not with a shift: 1<<31 is
     negative in JavaScript, so ((1<<z)-1) at z=31 is -2147483649 where the
     value should be 2147483647. The old guard stopped at z > 31, which left 31
     itself permitted and wrong.

     The value is discarded today -- it is read once, for
     num_ticks_per_picture_minus_1 -- so what this mainly has to get right is
     how many bits it consumes. Everything after it is read from wherever this
     leaves the reader, which is the shape #42 had. */
  uvlc(){
    let z = 0;
    /* f() returns 0 past the end of the buffer, so a reader looking for a 1
       that is not there would never find one and would hang the tab. The old
       bail-out at 32 doubled as that bound; the bound is now the buffer itself,
       so a legal 32-leading-zero uvlc is no longer mistaken for a broken one. */
    while (!this.f(1)){
      z++;
      if (this.p >= this.d.length * 8)
        throw new Error("That AV1 sequence header ends mid-number.");
    }
    /* Per spec, 32 or more leading zeros encodes the maximum and no value bits
       follow it. The terminating 1 has already been consumed above. */
    if (z >= 32) return 4294967295;
    return z ? (2 ** z) - 1 + this.f(z) : 0;
  }
}
export function findSequenceHeader(chunk){
  let p = 0;
  while (p < chunk.length){
    const h = chunk[p];
    const type = (h >> 3) & 0x0F, ext = (h >> 2) & 1, hasSize = (h >> 1) & 1;
    let q = p + 1 + (ext ? 1 : 0);
    let size = 0;
    if (hasSize){ let shift = 0;
      for (let i=0;i<8;i++){ const b = chunk[q++]; size += (b & 0x7F) * Math.pow(2, shift);
        shift += 7; if (!(b & 0x80)) break; }
    } else size = chunk.length - q;
    if (type === 1) return chunk.subarray(p, q + size);
    p = q + size;
  }
  return null;
}
/* Reads sequence_header_obu() far enough to fill in an AV1CodecConfigurationRecord.
   Split out from av1ConfigRecord so it can be tested against hand-built headers:
   Chrome's encoder emits one shape, and the branches it never takes are exactly
   the ones most likely to be wrong. `bits` is how far the reader got, which is
   what lets a test prove the whole header was consumed rather than merely that
   the first operating point looked plausible. */
export function parseSequenceHeader(obu){
  let q = 1 + ((obu[0] >> 2) & 1 ? 1 : 0);
  if ((obu[0] >> 1) & 1){ while (obu[q] & 0x80) q++; q++; }
  const r = new Bits(obu.subarray(q));
  const seqProfile = r.f(3);
  r.f(1);                                     // still_picture
  const reduced = r.f(1);
  let levelIdx = 0, tier = 0;
  if (reduced) levelIdx = r.f(5);
  else {
    let decoderModel = 0, delayBits = 0;
    if (r.f(1)){                              // timing_info_present_flag
      r.f(32); r.f(32);                       // num_units_in_display_tick, time_scale
      if (r.f(1)) r.uvlc();                   // equal_picture_interval
      decoderModel = r.f(1);
      // buffer_delay_length_minus_1 sizes operating_parameters_info() below,
      // so it has to be kept rather than skipped.
      if (decoderModel){ delayBits = r.f(5) + 1; r.f(32); r.f(5); r.f(5); }
    }
    const initialDelay = r.f(1);
    const ops = r.f(5) + 1;
    for (let i=0;i<ops;i++){
      r.f(12);                                // operating_point_idc
      const lvl = r.f(5);
      const t = lvl > 7 ? r.f(1) : 0;
      if (i === 0){ levelIdx = lvl; tier = t; }
      // operating_parameters_info(): decoder_buffer_delay, encoder_buffer_delay,
      // low_delay_mode_flag. Skipping it leaves every later operating point
      // being read from the wrong bit offset.
      if (decoderModel && r.f(1)){ r.f(delayBits); r.f(delayBits); r.f(1); }
      if (initialDelay && r.f(1)) r.f(4);
    }
  }
  return {seqProfile, levelIdx, tier, reduced, bits: r.p};
}

export function av1ConfigRecord(description, firstChunk){
  if (description && description.length) return description;
  const obu = findSequenceHeader(firstChunk);
  if (!obu) throw new Error("No AV1 sequence header in the first frame.");
  const {seqProfile, levelIdx, tier} = parseSequenceHeader(obu);
  // Canvas frames are always 8-bit 4:2:0 colour, so those fields are fixed.
  return cat([U8A([0x81, ((seqProfile & 7) << 5) | (levelIdx & 31),
                   ((tier & 1) << 7) | 0x0C, 0x00]), obu]);
}

export function sampleEntry(type, W, H, configBox){
  return box(type,
    U8A([0,0,0,0,0,0]), U16(1),
    U16(0), U16(0), U32(0), U32(0), U32(0),
    U16(W), U16(H),
    U32(0x00480000), U32(0x00480000), U32(0),
    U16(1), new Uint8Array(32),
    U16(0x0018), U8A([0xFF,0xFF]),
    configBox);
}

export function buildMoov(o, mdatOffset){
  const {W,H,samples,timescale,duration,entryType,configBox,handler} = o;
  const stts = [];
  for (const s of samples){
    const last = stts[stts.length-1];
    if (last && last[1] === s.duration) last[0]++; else stts.push([1, s.duration]);
  }
  const syncs = samples.map((s,i) => s.key ? i+1 : 0).filter(Boolean);
  const stbl = [
    fbox("stsd", 0, 0, U32(1), sampleEntry(entryType, W, H, configBox)),
    fbox("stts", 0, 0, U32(stts.length), ...stts.flatMap(([n,d]) => [U32(n), U32(d)])),
    ...(syncs.length === samples.length ? []
        : [fbox("stss", 0, 0, U32(syncs.length), ...syncs.map(U32))]),
    fbox("stsc", 0, 0, U32(1), U32(1), U32(samples.length), U32(1)),
    fbox("stsz", 0, 0, U32(0), U32(samples.length), ...samples.map(s => U32(s.data.length))),
    fbox("stco", 0, 0, U32(1), U32(mdatOffset))
  ];
  return box("moov",
    fbox("mvhd", 0, 0, U32(0), U32(0), U32(timescale), U32(duration),
      U32(0x00010000), U16(0x0100), U16(0), U32(0), U32(0), MATRIX,
      new Uint8Array(24), U32(2)),
    box("trak",
      fbox("tkhd", 0, 3, U32(0), U32(0), U32(1), U32(0), U32(duration),
        U32(0), U32(0), U16(0), U16(0), U16(0), U16(0), MATRIX,
        U32(W*65536), U32(H*65536)),
      box("mdia",
        fbox("mdhd", 0, 0, U32(0), U32(0), U32(timescale), U32(duration), U16(0x55C4), U16(0)),
        fbox("hdlr", 0, 0, U32(0), s4(handler), new Uint8Array(12), U8A([0])),
        box("minf",
          fbox("vmhd", 0, 1, U16(0), U16(0), U16(0), U16(0)),
          box("dinf", fbox("dref", 0, 0, U32(1), fbox("url ", 0, 1))),
          box("stbl", ...stbl)))));
}

export function buildMetaBox(W, H, configBox, itemOffset, itemLength){
  return fbox("meta", 0, 0,
    fbox("hdlr", 0, 0, U32(0), s4("pict"), new Uint8Array(12), U8A([0])),
    fbox("pitm", 0, 0, U16(1)),
    fbox("iloc", 0, 0, U8A([0x44, 0x00]), U16(1),
      U16(1), U16(0), U16(1), U32(itemOffset), U32(itemLength)),
    fbox("iinf", 0, 0, U16(1),
      fbox("infe", 2, 0, U16(1), U16(0), s4("av01"), U8A([0]))),
    box("iprp",
      box("ipco", configBox,
        fbox("ispe", 0, 0, U32(W), U32(H)),
        fbox("pixi", 0, 0, U8A([3,8,8,8]))),
      fbox("ipma", 0, 0, U32(1), U16(1), U8A([3, 0x81, 0x02, 0x03]))));
}

export function muxISOBMFF({W,H,samples,entryType,configBox,brands,avif}){
  const mdatBody = cat(samples.map(s => s.data));
  const duration = samples.reduce((a,s) => a + s.duration, 0);
  const ftyp = box("ftyp", s4(brands[0]), U32(0), ...brands.map(s4));
  const handler = avif ? "pict" : "vide";
  const build = mdatOffset => {
    const parts = [ftyp];
    if (avif) parts.push(buildMetaBox(W, H, configBox, mdatOffset, samples[0].data.length));
    parts.push(buildMoov({W,H,samples,timescale:1000,duration,entryType,configBox,handler},
                         mdatOffset));
    return parts;
  };
  // Offset fields are fixed width, so a throwaway pass gives the exact header size.
  const headerLen = build(0).reduce((a,b) => a + b.length, 0);
  const mdatOffset = headerLen + 8;
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + mdatBody.length);
  mdatHeader.set(s4("mdat"), 4);
  return cat([...build(mdatOffset), mdatHeader, mdatBody]);
}
