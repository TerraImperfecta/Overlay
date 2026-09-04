import { $ } from "./util.js";
import { composite } from "./compositing.js";
import { syncPlacementFields } from "./controls.js";
import { geometry } from "./geometry.js";
import { S, emptyEl, sctx, stage, stageBox } from "./state.js";

/* =====================================================================
   THE PREVIEW
   ---------------------------------------------------------------------
   The animation loop, how the stage is scaled to the panel, and the
   merged-timeline strip beneath it. Zoom is a property of looking rather
   than of the file, so it is neither persisted nor part of a render
   snapshot.
   ===================================================================== */

/* The preview used to be pinned to the source's natural size below 560px, so a
   32x32 GIF was shown as a 32px sprite in an 840px panel -- the subject of the
   tool, and the thing being dragged, was the smallest element on the page.
   Zoom is a property of looking, not of the file, so it is deliberately not
   persisted and not part of the render snapshot. */
export const ZOOM_STEPS = [.1,.15,.25,.33,.5,.67,1,2,3,4,6,8,12,16,24,32];

export const ZOOM_MAX = 32;

export let zoom = null;                        /* null = fit to the panel */

export function fitZoom(g){
  const box = stageBox.getBoundingClientRect();
  const avail = { w: box.width - 32, h: box.height - 32 };   /* .stage padding */
  if (!(avail.w > 0 && avail.h > 0 && g.w > 0 && g.h > 0)) return 1;
  const raw = Math.min(avail.w/g.w, avail.h/g.h);
  if (!isFinite(raw) || raw <= 0) return 1;
  /* Above 1:1 a whole-number scale keeps every source pixel the same size on
     screen; a fractional one makes some of them a row wider than their
     neighbours, which on pixel art reads as a defect in the file. */
  return raw >= 1 ? Math.min(ZOOM_MAX, Math.floor(raw)) : raw;
}

export const currentZoom = () => zoom === null ? fitZoom(geometry()) : zoom;

/* The fit scale is whatever the panel happens to allow -- 23x here, 17x on a
   shorter window -- so it is rarely one of the fixed steps. Without it on the
   ladder, stepping out of fit and back in lands somewhere else than where you
   started, which makes the buttons feel broken. */
export function zoomLadder(){
  const fit = fitZoom(geometry());
  const all = ZOOM_STEPS.some(v => Math.abs(v-fit) < 1e-6)
    ? ZOOM_STEPS.slice() : ZOOM_STEPS.concat(fit);
  return all.sort((a,b) => a-b);
}

export function stepZoom(dir){
  const cur = currentZoom(), ladder = zoomLadder();
  const next = dir > 0
    ? ladder.find(v => v > cur + 1e-6)
    : ladder.filter(v => v < cur - 1e-6).pop();
  if (next === undefined) return;             /* already at an end of the range */
  zoom = next;
  $("#zoomFit").setAttribute("aria-pressed", "false");
}

export const tl = $("#timeline"), tctx = tl.getContext("2d");

export let pausedAt = 0;

export function loop(){
  requestAnimationFrame(loop);
  const g = geometry();
  if (stage.width !== g.w || stage.height !== g.h){
    stage.width = g.w; stage.height = g.h;
  }
  /* Recomputed every frame rather than on a resize event, so the preview also
     follows the panel growing when a control below it appears or wraps. */
  const z = currentZoom();
  const cw = Math.max(1, Math.round(g.w*z)) + "px",
        ch = Math.max(1, Math.round(g.h*z)) + "px";
  if (stage.style.width !== cw){ stage.style.width = cw; stage.style.height = ch; }
  const pct = (z >= 1 ? Math.round(z*100) : Math.round(z*1000)/10) + "%";
  if ($("#zoomPct").textContent !== pct) $("#zoomPct").textContent = pct;

  const loaded = !!(S.src[0] || S.src[1]);
  if (emptyEl.hidden !== loaded) emptyEl.hidden = loaded;
  if (stage.hidden === loaded) stage.hidden = !loaded;
  syncPlacementFields();
  const plan = S.plan, dur = plan ? plan.outDur : 1000;
  const t = S.playing ? ((performance.now() - S.t0) % dur) : pausedAt;
  let snapped = t;
  if (plan){
    let lo = 0, hi = plan.times.length-1;
    while (lo <= hi){ const m = (lo+hi)>>1;
      if (plan.times[m] <= t){ snapped = plan.times[m]; lo = m+1; } else hi = m-1; }
    snapped += 1;
  }
  composite(sctx, g.w, g.h, snapped, g.dx, g.dy);
  $("#pos").textContent = (t/1000).toFixed(2) + "s";
  drawTimeline(t);
}

export function repeated(src, k, dur){
  if (src.static || !(src.duration > 0)) return [0];
  const out = [], eff = src.duration*k;
  for (let base = 0; base < dur-1; base += eff)
    for (const s of src.starts){ const t = base + s*k; if (t < dur) out.push(t); }
  return out;
}

export function drawTimeline(t){
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = tl.clientWidth || 600;
  if (tl.width !== Math.round(cssW*dpr)){ tl.width = Math.round(cssW*dpr); tl.height = Math.round(118*dpr); }
  const g = tctx; g.setTransform(dpr,0,0,dpr,0,0);
  const W = cssW, H = 118, L = 12, R = W-12, span = R-L;
  g.clearRect(0,0,W,H);
  const [A,B] = S.src, plan = S.plan;
  g.font = "9px ui-monospace, monospace"; g.textBaseline = "middle";
  if (!A || !B || !plan){
    g.fillStyle = "#8D93B5"; g.font = "11px ui-monospace, monospace";
    g.fillText("Waiting for two files.", L, 26); return;
  }
  const dur = plan.outDur, x = ms => L + span*(ms/dur);
  const lanes = [
    {y:16,h:20,color:"#FF3366",label:"BASE",   times:repeated(A, plan.kA, dur)},
    {y:46,h:26,color:"#FFCC00",label:"OUTPUT", times:plan.times},
    {y:82,h:20,color:"#33CCCC",label:"OVERLAY",times:repeated(B, plan.kB, dur)}];
  for (const lane of lanes){
    for (let i=0;i<lane.times.length;i++){
      const x0 = x(lane.times[i]);
      const x1 = i+1 < lane.times.length ? x(lane.times[i+1]) : R;
      g.fillStyle = lane.color; g.globalAlpha = i%2 ? .30 : .62;
      g.fillRect(x0, lane.y, Math.max(.6, x1-x0-.7), lane.h);
    }
    g.globalAlpha = 1; g.fillStyle = lane.color;
    g.fillText(lane.label + " ×" + lane.times.length, L, lane.y-6);
  }
  const px = x(t);
  g.strokeStyle = "#EDEEF5"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(px,8); g.lineTo(px,H-6); g.stroke();
  g.fillStyle = "#8D93B5"; g.fillText((dur/1000).toFixed(2)+"s loop", R-58, H-8);
}

/* Returns the new playing state; the caller owns the button's label. */
export function togglePlay(){
  if (S.playing) pausedAt = (performance.now() - S.t0) % (S.plan ? S.plan.outDur : 1000);
  else S.t0 = performance.now() - pausedAt;
  S.playing = !S.playing;
  return S.playing;
}

export function resetZoom(){ zoom = null; }
