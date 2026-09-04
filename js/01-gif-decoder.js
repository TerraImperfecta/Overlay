import { $ } from "./util.js";

/* =====================================================================
   1. GIF DECODER
   ===================================================================== */
/* A GIF header may declare any size up to 65535 a side, and nothing downstream
   questions it. flattenGIF allocates W*H*4 for the canvas and another copy per
   frame, so a thirty-byte file can ask for gigabytes. 65535 square wants 17GB
   and throws; 16000 square wants 1GB *per frame* and does not throw at all --
   it simply eats the machine. Both are refused here, before anything allocates.

   These are policy caps rather than format limits: 16384 is the conventional
   canvas ceiling, and 64 megapixels keeps one decoded frame under a quarter of
   a gigabyte. Real GIFs are orders of magnitude below both. */
export const GIF_MAX_SIDE = 16384, GIF_MAX_PIXELS = 64e6;

/* Walks the length-prefixed sub-block chain. The bound is the point: without
   `p < d.length`, a truncated file runs off the end, `d[p]` is undefined,
   `p += 1 + undefined` makes p NaN, `d[NaN]` is undefined, and the loop never
   terminates -- freezing the tab rather than reporting a bad file. */
export function skipBlocks(d,p){
  while (p < d.length && d[p] !== 0) p += 1 + d[p];
  if (p >= d.length) throw new Error("That GIF ends in the middle of a block.");
  return p+1;
}

export function lzwDecode(minCodeSize, data, pixelCount){
  const MAX = 4096, clear = 1 << minCodeSize, eoi = clear + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(MAX), suffix = new Uint8Array(MAX), stack = new Uint8Array(MAX+1);
  for (let i=0;i<clear;i++){ prefix[i]=0; suffix[i]=i; }
  let codeSize = minCodeSize+1, codeMask = (1<<codeSize)-1;
  let available = clear+2, old = -1, first = 0, datum = 0, bits = 0, top = 0, bi = 0, i = 0;
  while (i < pixelCount){
    if (top === 0){
      if (bits < codeSize){ if (bi >= data.length) break; datum |= data[bi++] << bits; bits += 8; continue; }
      let code = datum & codeMask; datum >>= codeSize; bits -= codeSize;
      if (code === eoi) break;
      if (code === clear){ codeSize = minCodeSize+1; codeMask = (1<<codeSize)-1;
                           available = clear+2; old = -1; continue; }
      if (old === -1){ stack[top++] = suffix[code]; old = code; first = code; continue; }
      const inCode = code;
      if (code >= available){ stack[top++] = first; code = old; }
      while (code >= clear){ stack[top++] = suffix[code]; code = prefix[code]; }
      first = suffix[code]; stack[top++] = first;
      if (available < MAX){ prefix[available] = old; suffix[available] = first; available++;
        if ((available & codeMask) === 0 && available < MAX){ codeSize++; codeMask += available; } }
      old = inCode;
    }
    out[i++] = stack[--top];
  }
  return out;
}

export function deinterlace(px,w,h){
  const src = px.slice(), off=[0,4,2,1], jump=[8,8,4,2]; let row=0;
  for (let pass=0; pass<4; pass++)
    for (let y=off[pass]; y<h; y+=jump[pass]){ px.set(src.subarray(row*w,row*w+w), y*w); row++; }
}

export function parseGIF(buffer){
  const d = new Uint8Array(buffer);
  if (String.fromCharCode(d[0],d[1],d[2]) !== "GIF") throw new Error("Not a GIF.");
  let p = 6;
  const width = d[p]|d[p+1]<<8; p+=2;
  const height = d[p]|d[p+1]<<8; p+=2;
  if (!(width > 0 && height > 0)) throw new Error("That GIF declares a zero size.");
  if (width > GIF_MAX_SIDE || height > GIF_MAX_SIDE || width*height > GIF_MAX_PIXELS)
    throw new Error(`That GIF declares ${width}×${height}, which is too large to decode.`);
  const flags = d[p++]; p+=2;
  let gct = null;
  if (flags & 0x80){ const n = 2 << (flags & 7); gct = d.subarray(p, p+n*3); p += n*3; }
  const frames = []; let gce = null;
  while (p < d.length){
    const b = d[p++];
    if (b === 0x3B) break;
    if (b === 0x21){
      const label = d[p++];
      if (label === 0xF9){
        const size = d[p], packed = d[p+1];
        gce = { disposal:(packed>>2)&7, transparent:(packed&1)?d[p+4]:-1, delay:d[p+2]|d[p+3]<<8 };
        p = skipBlocks(d, p+1+size);
      } else p = skipBlocks(d, p);
    } else if (b === 0x2C){
      const x=d[p]|d[p+1]<<8, y=d[p+2]|d[p+3]<<8, w=d[p+4]|d[p+5]<<8, h=d[p+6]|d[p+7]<<8;
      const f = d[p+8]; p += 9;
      let lct = null;
      if (f & 0x80){ const n = 2 << (f&7); lct = d.subarray(p, p+n*3); p += n*3; }
      const minCode = d[p++];
      let q = p, total = 0;
      while (q < d.length && d[q] !== 0){ total += d[q]; q += 1 + d[q]; }
      if (q >= d.length) throw new Error("That GIF ends in the middle of a frame.");
      const data = new Uint8Array(total); let o = 0; q = p;
      while (q < d.length && d[q] !== 0){
        const n = d[q]; data.set(d.subarray(q+1,q+1+n), o); o += n; q += 1+n;
      }
      p = q + 1;
      const indices = lzwDecode(minCode, data, w*h);
      if (f & 0x40) deinterlace(indices, w, h);
      const g = gce || {disposal:0, transparent:-1, delay:0};
      frames.push({x,y,w,h,indices,palette:lct||gct,disposal:g.disposal,
                   transparent:g.transparent, delay:g.delay});
      gce = null;
    } else break;
  }
  if (!frames.length) throw new Error("No frames in that GIF.");
  return {width, height, frames};
}

export const realDelay = cs => { const ms = cs*10; return ms < 20 ? 100 : ms; };

export function flattenGIF(gif){
  const W = gif.width, H = gif.height;
  const cur = new Uint8ClampedArray(W*H*4);
  const out = []; let saved = null;
  for (const f of gif.frames){
    if (f.disposal === 3) saved = cur.slice();
    const pal = f.palette;
    if (pal) for (let yy=0; yy<f.h; yy++){
      const gy = f.y+yy; if (gy<0||gy>=H) continue;
      for (let xx=0; xx<f.w; xx++){
        const gx = f.x+xx; if (gx<0||gx>=W) continue;
        const idx = f.indices[yy*f.w+xx]; if (idx === f.transparent) continue;
        const o = (gy*W+gx)*4, q = idx*3;
        cur[o]=pal[q]; cur[o+1]=pal[q+1]; cur[o+2]=pal[q+2]; cur[o+3]=255;
      }
    }
    out.push({ data:new Uint8ClampedArray(cur), delay:realDelay(f.delay) });
    if (f.disposal === 2){
      for (let yy=0; yy<f.h; yy++){ const gy=f.y+yy; if(gy<0||gy>=H)continue;
        for (let xx=0; xx<f.w; xx++){ const gx=f.x+xx; if(gx<0||gx>=W)continue;
          const o=(gy*W+gx)*4; cur[o]=cur[o+1]=cur[o+2]=cur[o+3]=0; } }
    } else if (f.disposal === 3 && saved) cur.set(saved);
  }
  return out;
}
