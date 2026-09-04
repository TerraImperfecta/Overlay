"use strict";

/* =====================================================================
   5. ANIMATED WEBP  (still WebPs remuxed into ANMF chunks)
   ===================================================================== */
function riffChunks(u8){
  const out = []; let p = 12;
  while (p+8 <= u8.length){
    const cc = String.fromCharCode(u8[p],u8[p+1],u8[p+2],u8[p+3]);
    const size = (u8[p+4]|u8[p+5]<<8|u8[p+6]<<16) + u8[p+7]*16777216;
    out.push({cc, hdr:p, size});
    p += 8 + size + (size & 1);
  }
  return out;
}
function anmfPayload(still, durationMs, W, H){
  const keep = riffChunks(still).filter(c => c.cc==="ALPH"||c.cc==="VP8 "||c.cc==="VP8L");
  if (!keep.length) throw new Error("Unexpected WebP layout from this browser.");
  let body = 0;
  for (const c of keep) body += Math.min(8+c.size+(c.size&1), still.length-c.hdr);
  const out = new Uint8Array(16+body);
  const w24 = (o,v) => { out[o]=v&255; out[o+1]=(v>>8)&255; out[o+2]=(v>>16)&255; };
  w24(0,0); w24(3,0); w24(6,W-1); w24(9,H-1); w24(12, Math.min(16777215, durationMs));
  out[15] = 2;
  let p = 16;
  for (const c of keep){
    const len = Math.min(8+c.size+(c.size&1), still.length-c.hdr);
    out.set(still.subarray(c.hdr, c.hdr+len), p); p += len;
  }
  return {payload:out, hasAlpha: keep.some(c => c.cc==="ALPH"||c.cc==="VP8L")};
}
function muxWebP(W,H,parts,hasAlpha){
  const w = new BW();
  const chunk = (cc,data) => { w.str(cc); w.u32(data.length); w.raw(data);
                               if (data.length & 1) w.u8(0); };
  w.str("RIFF"); w.u32(0); w.str("WEBP");
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (hasAlpha ? 0x10 : 0);
  const w24 = (a,o,v) => { a[o]=v&255; a[o+1]=(v>>8)&255; a[o+2]=(v>>16)&255; };
  w24(vp8x,4,W-1); w24(vp8x,7,H-1);
  chunk("VP8X", vp8x);
  chunk("ANIM", new Uint8Array(6));
  for (const p of parts) chunk("ANMF", p);
  const bytes = w.done(), size = bytes.length - 8;
  bytes[4]=size&255; bytes[5]=(size>>8)&255; bytes[6]=(size>>16)&255; bytes[7]=(size>>>24)&255;
  return bytes;
}
