"use strict";

/* =====================================================================
   8. EBML MUXER  →  WebM
   ===================================================================== */
function ebmlSize(n){
  for (let len=1; len<=8; len++){
    if (n < Math.pow(2, 7*len) - 1){
      const a = new Uint8Array(len);
      let v = n + Math.pow(2, 7*len);
      for (let i=len-1;i>=0;i--){ a[i] = v % 256; v = Math.floor(v/256); }
      return a;
    }
  }
  throw new Error("Element too large for EBML.");
}
const el = (id, payload) => cat([U8A(id), ebmlSize(payload.length), payload]);
function ebmlUint(v){
  const bytes = []; let n = Math.max(0, Math.round(v));
  do { bytes.unshift(n % 256); n = Math.floor(n/256); } while (n > 0);
  return U8A(bytes);
}
const ebmlFloat64 = v => { const a = new Uint8Array(8);
  new DataView(a.buffer).setFloat64(0, v); return a; };
const ebmlStr = s => U8A([...s].map(c => c.charCodeAt(0)));

function muxWebM({W,H,samples,codecId,codecPrivate}){
  const header = el([0x1A,0x45,0xDF,0xA3], cat([
    el([0x42,0x86], ebmlUint(1)), el([0x42,0xF7], ebmlUint(1)),
    el([0x42,0xF2], ebmlUint(4)), el([0x42,0xF3], ebmlUint(8)),
    el([0x42,0x82], ebmlStr("webm")), el([0x42,0x87], ebmlUint(2)),
    el([0x42,0x85], ebmlUint(2))]));
  const duration = samples.reduce((a,s) => a + s.duration, 0);
  const info = el([0x15,0x49,0xA9,0x66], cat([
    el([0x2A,0xD7,0xB1], ebmlUint(1000000)),        // one tick = 1 ms
    el([0x4D,0x80], ebmlStr("overlay")), el([0x57,0x41], ebmlStr("overlay")),
    el([0x44,0x89], ebmlFloat64(duration))]));
  const trackParts = [
    el([0xD7], ebmlUint(1)), el([0x73,0xC5], ebmlUint(1)), el([0x83], ebmlUint(1)),
    el([0x86], ebmlStr(codecId))];
  if (codecPrivate && codecPrivate.length) trackParts.push(el([0x63,0xA2], codecPrivate));
  trackParts.push(el([0xE0], cat([el([0xB0], ebmlUint(W)), el([0xBA], ebmlUint(H))])));
  const tracks = el([0x16,0x54,0xAE,0x6B], el([0xAE], cat(trackParts)));

  const clusters = []; let i = 0;
  while (i < samples.length){
    const base = samples[i].timestamp, blocks = [];
    while (i < samples.length){
      const rel = samples[i].timestamp - base;
      if (rel > 30000) break;
      const s = samples[i];
      const block = new Uint8Array(4 + s.data.length);
      block[0] = 0x81;                                   // track 1 as a vint
      new DataView(block.buffer).setInt16(1, rel);
      block[3] = s.key ? 0x80 : 0x00;
      block.set(s.data, 4);
      blocks.push(el([0xA3], block));
      i++;
    }
    clusters.push(el([0x1F,0x43,0xB6,0x75], cat([el([0xE7], ebmlUint(base)), ...blocks])));
  }
  return cat([header, el([0x18,0x53,0x80,0x67], cat([info, tracks, ...clusters]))]);
}
