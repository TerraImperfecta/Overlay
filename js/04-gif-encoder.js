import { $ } from "./util.js";
import { frameAt } from "./03-timeline.js";
import { Cancelled, cancelling } from "./11a-state.js";
import { layerBox } from "./11b-geometry.js";
import { composite, compositeInto, renderContext } from "./11c-compositing.js";

/* =====================================================================
   4. GIF QUANTIZER + ENCODER
   ===================================================================== */
export function buildPalette(framesRGBA, reserve){
  const cap = reserve ? 255 : 256;
  const exact = new Map(); let overflow = false;
  outer: for (const px of framesRGBA)
    for (let i = 0; i < px.length; i += 4){
      if (px[i+3] < 128) continue;
      const key = (px[i]<<16)|(px[i+1]<<8)|px[i+2];
      if (!exact.has(key)){ exact.set(key, exact.size);
        if (exact.size > cap){ overflow = true; break outer; } }
    }
  if (!overflow){
    const pal = new Uint8Array(Math.max(1, exact.size)*3);
    for (const [key,i] of exact){ pal[i*3]=key>>16&255; pal[i*3+1]=key>>8&255; pal[i*3+2]=key&255; }
    return {palette:pal, exact, lut:null, count:Math.max(1, exact.size)};
  }
  const hist = new Uint32Array(32768);
  const sR = new Float64Array(32768), sG = new Float64Array(32768), sB = new Float64Array(32768);
  for (const px of framesRGBA)
    for (let i = 0; i < px.length; i += 4){
      if (px[i+3] < 128) continue;
      const r=px[i], g=px[i+1], b=px[i+2];
      const k = ((r>>3)<<10)|((g>>3)<<5)|(b>>3);
      hist[k]++; sR[k]+=r; sG[k]+=g; sB[k]+=b;
    }
  const occ = []; for (let i=0;i<32768;i++) if (hist[i]) occ.push(i);
  const mkBox = list => {
    let n=0, lo=[31,31,31], hi=[0,0,0];
    for (const k of list){ n+=hist[k];
      const c=[(k>>10)&31,(k>>5)&31,k&31];
      for (let j=0;j<3;j++){ if(c[j]<lo[j])lo[j]=c[j]; if(c[j]>hi[j])hi[j]=c[j]; } }
    const span=[hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]];
    const ch = span.indexOf(Math.max(...span));
    return {list,n,ch,span:span[ch]};
  };
  let boxes = [mkBox(occ)];
  while (boxes.length < cap){
    let best=-1, score=0;
    for (let i=0;i<boxes.length;i++){ const s = boxes[i].span*boxes[i].n;
      if (boxes[i].list.length>1 && s>score){ score=s; best=i; } }
    if (best<0) break;
    const box = boxes[best], sh = [10,5,0][box.ch];
    const sorted = box.list.slice().sort((a,b) => ((a>>sh)&31)-((b>>sh)&31));
    let half = box.n/2, run = 0, cut = 0;
    for (; cut<sorted.length-1; cut++){ run += hist[sorted[cut]]; if (run>=half) break; }
    boxes.splice(best,1, mkBox(sorted.slice(0,cut+1)), mkBox(sorted.slice(cut+1)));
  }
  const count = boxes.length, pal = new Uint8Array(count*3);
  boxes.forEach((box,i) => { let n=0,r=0,g=0,b=0;
    for (const k of box.list){ n+=hist[k]; r+=sR[k]; g+=sG[k]; b+=sB[k]; }
    pal[i*3]=Math.round(r/n); pal[i*3+1]=Math.round(g/n); pal[i*3+2]=Math.round(b/n); });
  const lut = new Uint8Array(32768);
  for (let k=0;k<32768;k++){
    const r=((k>>10)&31)*8.2258, g=((k>>5)&31)*8.2258, b=(k&31)*8.2258;
    let best=0, bd=Infinity;
    for (let i=0;i<count;i++){ const dr=r-pal[i*3], dg=g-pal[i*3+1], db=b-pal[i*3+2];
      const d = dr*dr*0.299+dg*dg*0.587+db*db*0.114;
      if (d<bd){ bd=d; best=i; } }
    lut[k]=best;
  }
  return {palette:pal, exact:null, lut, count};
}

export class BW {
  constructor(){ this.b = new Uint8Array(1<<16); this.n = 0; }
  need(k){ if (this.n+k > this.b.length){ let L=this.b.length; while(L<this.n+k) L*=2;
    const nb = new Uint8Array(L); nb.set(this.b.subarray(0,this.n)); this.b = nb; } }
  u8(v){ this.need(1); this.b[this.n++] = v & 255; }
  u16(v){ this.need(2); this.b[this.n++]=v&255; this.b[this.n++]=(v>>8)&255; }
  u32(v){ this.u16(v & 0xFFFF); this.u16((v>>>16) & 0xFFFF); }
  u32be(v){ this.need(4); this.b[this.n++]=(v>>>24)&255; this.b[this.n++]=(v>>>16)&255;
            this.b[this.n++]=(v>>>8)&255; this.b[this.n++]=v&255; }
  raw(a){ this.need(a.length); this.b.set(a,this.n); this.n += a.length; }
  str(s){ for(let i=0;i<s.length;i++) this.u8(s.charCodeAt(i)); }
  blocks(a){ let p=0; while(p<a.length){ const n=Math.min(255,a.length-p);
    this.u8(n); this.raw(a.subarray(p,p+n)); p+=n; } this.u8(0); }
  done(){ return this.b.subarray(0,this.n); }
}

export function lzwEncode(pixels, minCode){
  const clear = 1<<minCode, eoi = clear+1;
  let codeSize = minCode+1, next = clear+2;
  const dict = new Map(), out = new BW();
  let cur = 0, curBits = 0;
  const emit = code => { cur |= code<<curBits; curBits += codeSize;
    while (curBits>=8){ out.u8(cur); cur >>>= 8; curBits -= 8; } };
  emit(clear);
  let prefix = pixels[0];
  for (let i=1;i<pixels.length;i++){
    const k = pixels[i], key = (prefix<<8)|k;
    const hit = dict.get(key);
    if (hit !== undefined){ prefix = hit; continue; }
    emit(prefix);
    if (next < 4096){ dict.set(key, next++);
      if (next > (1<<codeSize) && codeSize < 12) codeSize++; }
    else { emit(clear); dict.clear(); codeSize = minCode+1; next = clear+2; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (curBits>0) out.u8(cur);
  return out.done();
}

export function encodeGIF(W,H,palette,colorCount,frames,transparentIndex){
  let bits = 1;
  while ((1<<bits) < Math.max(2, colorCount + (transparentIndex>=0?1:0))) bits++;
  bits = Math.min(8, bits);
  const palSize = 1<<bits, gct = new Uint8Array(palSize*3);
  gct.set(palette.subarray(0, Math.min(palette.length, palSize*3)));
  const w = new BW();
  w.str("GIF89a"); w.u16(W); w.u16(H);
  w.u8(0x80 | ((bits-1)<<4) | (bits-1)); w.u8(0); w.u8(0);
  w.raw(gct);
  w.u8(0x21); w.u8(0xFF); w.u8(11); w.str("NETSCAPE2.0");
  w.u8(3); w.u8(1); w.u16(0); w.u8(0);
  for (const f of frames){
    w.u8(0x21); w.u8(0xF9); w.u8(4);
    w.u8((f.disposal<<2) | (transparentIndex>=0?1:0));
    w.u16(f.delayCs); w.u8(transparentIndex>=0?transparentIndex:0); w.u8(0);
    w.u8(0x2C); w.u16(f.x); w.u16(f.y); w.u16(f.w); w.u16(f.h); w.u8(0);
    const minCode = Math.max(2, bits);
    w.u8(minCode); w.blocks(lzwEncode(f.indices, minCode));
  }
  w.u8(0x3B);
  return w.done();
}

/* Everything between "here are the composited frames" and "here are the GIF
   bytes": palette, quantization, inter-frame diffing, LZW. Kept free of any
   reference to the page -- no S, no DOM -- because it is also the body of the
   worker below, stringified. `report` is awaited so the main-thread copy can
   yield between chunks; in the worker it just posts a message. */
export async function gifFromFrames(job, report){
  const {W, H, count, delaysCs, needsAlpha, rgba} = job;
  await report("Building palette");
  const {palette, exact, lut, count: colorCount} = buildPalette(rgba, true);
  const transparentIndex = colorCount;
  const pal = new Uint8Array((colorCount+1)*3); pal.set(palette.subarray(0, colorCount*3));
  const map = (r,gg,b) => exact ? exact.get((r<<16)|(gg<<8)|b)
                                : lut[((r>>3)<<10)|((gg>>3)<<5)|(b>>3)];
  const frames = []; let prev = null;
  for (let i=0;i<count;i++){
    const px = rgba[i], idx = new Uint8Array(W*H);
    for (let p=0,j=0;p<px.length;p+=4,j++)
      idx[j] = px[p+3]<128 ? transparentIndex : map(px[p],px[p+1],px[p+2]);
    if (!needsAlpha && prev){
      let x0=W,y0=H,x1=-1,y1=-1;
      for (let y=0,j=0;y<H;y++) for (let x=0;x<W;x++,j++)
        if (idx[j]!==prev[j]){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
      if (x1<0){ x0=y0=0; x1=y1=0; }
      const fw=x1-x0+1, fh=y1-y0+1, sub=new Uint8Array(fw*fh);
      for (let y=0;y<fh;y++) for (let x=0;x<fw;x++){
        const j=(y+y0)*W+(x+x0);
        sub[y*fw+x] = idx[j]===prev[j] ? transparentIndex : idx[j];
      }
      frames.push({x:x0,y:y0,w:fw,h:fh,indices:sub,delayCs:delaysCs[i],disposal:1});
    } else frames.push({x:0,y:0,w:W,h:H,indices:idx,delayCs:delaysCs[i],
                        disposal: needsAlpha?2:1});
    prev = idx;
    if (i%8===0) await report(`Encoding ${i+1}/${count}`);
  }
  await report("Writing file");
  return {bytes: encodeGIF(W,H,pal,colorCount,frames,transparentIndex),
          palette: {exact: !!exact, colors: colorCount}};
}

/* The worker source is assembled from the functions above rather than written
   out a second time, so there is exactly one implementation to keep correct.
   It is a Blob URL rather than a file because index.html still ships as one
   file; if a build step ever lands, this can become a real module. */
export let gifWorkerURL = null;
export function gifWorkerSource(){
  /* frameAt, layerBox, composite, renderContext and compositeInto are the same
     functions the preview runs, carried across as source rather than rewritten.
     Two implementations of compositing is the trap #29 avoided for quantization
     and there is no reason to fall into it here.

     composite() and layerBox() read `view || S`, and there is no S in a worker;
     the job always carries a view, so that branch is never taken. */
  return [BW, buildPalette, lzwEncode, encodeGIF, gifFromFrames,
          frameAt, layerBox, composite, renderContext, compositeInto]
    .map(fn => fn.toString()).join("\n\n") + `

/* The compositing loop, which used to run on the main thread. It is the whole
   of the block that #29 left behind -- 44 of the 55 ms it took at 768 square,
   measured in #72 -- and the frames it produces are what gifFromFrames wants. */
function compositeFrames(job, progress){
  const {W, H, g, count, times, view} = job;
  const cx = renderContext(new OffscreenCanvas(W, H), false);
  const rgba = [];
  for (let i = 0; i < count; i++){
    compositeInto(cx, W, H, g, times[i] + 1, false, view);
    rgba.push(cx.getImageData(0, 0, W, H).data);
    if (i % 8 === 0) progress("Compositing " + (i+1) + "/" + count);
  }
  return rgba;
}

self.onmessage = async e => {
  try {
    const job = e.data;
    const progress = text => self.postMessage({type:"progress", text});
    /* A job that already carries frames was composited by the caller, which is
       what the main-thread fallback does. */
    if (!job.rgba) job.rgba = compositeFrames(job, progress);
    const out = await gifFromFrames(job, progress);
    self.postMessage({type:"done", bytes: out.bytes, palette: out.palette}, [out.bytes.buffer]);
  } catch (err){
    self.postMessage({type:"error", message: (err && err.message) || String(err)});
  }
};`;
}

/* Null when Workers are unavailable or refused, so the caller can fall back to
   running the same code on the main thread. */
export function makeGifWorker(){
  if (typeof Worker === "undefined") return null;
  try {
    if (!gifWorkerURL)
      gifWorkerURL = URL.createObjectURL(new Blob([gifWorkerSource()], {type:"text/javascript"}));
    return new Worker(gifWorkerURL);
  } catch { return null; }
}

/* Runs the job in `worker`, relaying progress and honouring Cancel. Any rgba
   buffers are transferred, not copied -- they are several megabytes at the
   sizes where this matters, and nothing needs them afterwards. The ImageBitmaps
   in a view are the exception and are cloned; see workerView. */
export function runGifWorker(worker, job, say){
  return new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "progress"){
        say(m.text);
        /* Progress messages double as cancellation checkpoints: the main thread
           is otherwise sitting in one long await with nowhere to notice. */
        if (cancelling){ worker.terminate(); reject(new Cancelled()); }
      } else if (m.type === "done") resolve({bytes: m.bytes, palette: m.palette});
      else reject(new Error(m.message || "The GIF worker failed."));
    };
    worker.onerror = e => reject(new Error(e.message || "The GIF worker failed to run."));
    worker.postMessage(job, job.rgba ? job.rgba.map(a => a.buffer) : []);
  });
}
