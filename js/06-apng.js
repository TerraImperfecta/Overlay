"use strict";

/* =====================================================================
   6. APNG  (still PNGs remuxed into fcTL/fdAT frames)
   ===================================================================== */
const CRC_T = (() => { const t = new Uint32Array(256);
  for (let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1;
    t[n]=c>>>0; } return t; })();
function crc32(buf,start,end){
  let c = 0xFFFFFFFF;
  for (let i=start;i<end;i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c>>>8);
  return (c ^ 0xFFFFFFFF)>>>0;
}
function pngChunks(u8){
  const out = []; let p = 8;
  while (p+8 <= u8.length){
    const len = (u8[p]<<24|u8[p+1]<<16|u8[p+2]<<8|u8[p+3])>>>0;
    out.push({type:String.fromCharCode(u8[p+4],u8[p+5],u8[p+6],u8[p+7]), len, data:p+8});
    p += 12 + len;
  }
  return out;
}
function muxAPNG(stills, delaysMs, W, H){
  const first = pngChunks(stills[0]);
  const ihdr = first.find(c => c.type === "IHDR");
  if (!ihdr) throw new Error("Unexpected PNG layout.");
  const ihdrBytes = stills[0].subarray(ihdr.data, ihdr.data+ihdr.len);
  const w = new BW();
  w.raw(new Uint8Array([137,80,78,71,13,10,26,10]));
  const put = (type,data) => { w.u32be(data.length); const at = w.n;
    w.str(type); w.raw(data); w.u32be(crc32(w.b, at, w.n)); };
  put("IHDR", ihdrBytes);
  const actl = new BW(); actl.u32be(stills.length); actl.u32be(0);
  put("acTL", actl.done());
  let seq = 0;
  for (let i=0;i<stills.length;i++){
    const chunks = pngChunks(stills[i]);
    const hdr = chunks.find(c => c.type === "IHDR");
    const same = hdr && hdr.len === ihdr.len &&
      stills[i].subarray(hdr.data, hdr.data+hdr.len).every((v,j) => v === ihdrBytes[j]);
    if (!same) throw new Error("Frames came back with mismatched PNG headers.");
    const idats = chunks.filter(c => c.type === "IDAT");
    let total = 0; for (const c of idats) total += c.len;
    const data = new Uint8Array(total); let o = 0;
    for (const c of idats){ data.set(stills[i].subarray(c.data, c.data+c.len), o); o += c.len; }
    const fctl = new Uint8Array(26);
    const dv = new DataView(fctl.buffer);
    dv.setUint32(0, seq++); dv.setUint32(4, W); dv.setUint32(8, H);
    dv.setUint32(12, 0); dv.setUint32(16, 0);
    dv.setUint16(20, Math.min(65535, delaysMs[i])); dv.setUint16(22, 1000);
    fctl[24] = 0; fctl[25] = 0;
    put("fcTL", fctl);
    if (i === 0) put("IDAT", data);
    else { const s = seq++; const fd = new Uint8Array(4+data.length);
           new DataView(fd.buffer).setUint32(0, s); fd.set(data, 4); put("fdAT", fd); }
  }
  put("IEND", new Uint8Array(0));
  return w.done();
}
