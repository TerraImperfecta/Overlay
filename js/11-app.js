import { $, esc, idle } from "./util.js";
import { frameAt, lcm, planTimeline } from "./03-timeline.js";
import { el } from "./08-webm.js";

/* =====================================================================
   11. APP STATE + COMPOSITING
   ===================================================================== */
export const S = {
  src:[null,null], blend:"source-over", opacity:1,
  /* Placement per layer, in "base-natural" units: x and y are the layer's
     centre as a fraction of the base's own width and height, scale multiplies
     the layer's natural size. The defaults put the base exactly where it used
     to be pinned, and the overlay centred on it, so this is the old behaviour
     with the base's transform made explicit rather than assumed. */
  place:[{scale:1, x:.5, y:.5}, {scale:1, x:.5, y:.5}], sel:1,
  canvasMode:"base", bg:"transparent", bgColor:"#000000",
  sync:"auto", maxFrames:180, outScale:1, quality:.82,
  playing:true, t0:performance.now(), plan:null
};
export const stage = $("#stage"), sctx = stage.getContext("2d", {willReadFrequently:true});
export const stageBox = $(".stage"), emptyEl = $("#empty");

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

/* Where a layer sits, in base-natural units. The base's own size is the ruler
   for both layers, which keeps placement resolution-independent and keeps the
   defaults identical to the old base-pinned behaviour. */
export function layerBox(i, view){
  const v = view || S;
  const src = v.src[i], A = v.src[0], p = v.place[i];
  if (!src || !A) return null;
  const w = src.width * p.scale, h = src.height * p.scale;
  const cx = A.width * p.x, cy = A.height * p.y;
  return {x: cx - w/2, y: cy - h/2, w, h};
}

export function geometry(view){
  const v = view || S;
  const [A,B] = v.src;
  if (!A) return {w:320,h:240,dx:0,dy:0};
  const a = layerBox(0, v), b = B ? layerBox(1, v) : null;
  /* "Base size" is the base's placed rectangle, so scaling the base scales the
     output and moving it slides the overlay underneath rather than resizing
     anything. "Fit both" is the union of the two placed rectangles. */
  const box = (v.canvasMode === "base" || !b)
    ? a
    : (() => {
        const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
        const maxX = Math.max(a.x + a.w, b.x + b.w);
        const maxY = Math.max(a.y + a.h, b.y + b.h);
        return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
      })();
  /* `|| 0` normalises -0, which negating a zero offset produces. Harmless to
     draw with, but it is not what this function used to return and Object.is
     can tell the difference. */
  return {w: Math.max(1, Math.ceil(box.w)), h: Math.max(1, Math.ceil(box.h)),
          dx: -box.x || 0, dy: -box.y || 0};
}

/* Placement is stored as the layer's *centre*, as a fraction of the base's
   natural size, because that is what survives the base being swapped for one of
   a different size. Nobody thinks in those units. These two convert to and from
   the top-left corner in base pixels, which is what "16 pixels from the left
   edge" means and what the numeric fields show.

   Base pixels rather than output pixels on purpose: in "Fit both" the canvas
   origin moves when the overlay does, so a typed 0 would not read back as 0.
   With the default base placement the two are identical anyway. */
export function layerPos(i, view){
  const b = layerBox(i, view);
  return b ? {x: b.x, y: b.y} : null;
}

export function setLayerPos(i, x, y){
  const A = S.src[0], src = S.src[i], p = S.place[i];
  if (!A || !src) return false;
  const w = src.width * p.scale, h = src.height * p.scale;
  /* A half-typed or emptied field parses to NaN; that axis is left alone rather
     than throwing the layer to the corner while someone is still typing. */
  if (Number.isFinite(x)) p.x = (x + w/2) / A.width;
  if (Number.isFinite(y)) p.y = (y + h/2) / A.height;
  return true;
}

/* ---- placement history (#62) -----------------------------------------------

   Only placement. Format, quality, sync mode and the rest are single controls
   whose previous value is visible in the control itself and which persist
   between visits, so a general undo stack would be a much larger commitment for
   much less benefit.

   Entries are whole placement states rather than deltas. There are two layers of
   three numbers each, so a snapshot costs nothing, and restoring one cannot
   drift the way replaying inverse operations can. `sel` travels with the state
   so an undo selects the layer it just moved -- otherwise the size slider and
   the position fields would describe a layer that did not change. */
export const HISTORY_MAX = 50;
/* Long enough that a held arrow key or a slider drag is one entry, short enough
   that two deliberate presses are two. */
export const COALESCE_MS = 700;
export let past = [], future = [], gesture = null;

export const placeState = () => ({ place: S.place.map(p => ({...p})), sel: S.sel });
export const samePlace = (a, b) => a.sel === b.sel && a.place.every((p, i) =>
  p.scale === b.place[i].scale && p.x === b.place[i].x && p.y === b.place[i].y);

/* Called immediately *before* placement is mutated. A gesture is a run of
   changes from one source -- a drag, a held arrow, the digits of a typed
   number -- and records the state from before the run, not before each change.
   Without that the history fills with noise and undo appears not to work. */
export function beginChange(key){
  const now = performance.now();
  if (gesture && gesture.key === key && now - gesture.at < COALESCE_MS){
    gesture.at = now;
    return;
  }
  endChange();
  gesture = { key, before: placeState(), at: now };
}

/* Called when a gesture is definitely over -- pointerup, a field losing focus,
   a different gesture starting, or an undo about to read the stack. */
export function endChange(){
  if (!gesture) return;
  const before = gesture.before;
  gesture = null;
  /* A drag that never moved, or a field re-typed to the same number, is not a
     step; it would otherwise cost the user an undo that does nothing. */
  if (samePlace(before, placeState())) return;
  past.push(before);
  if (past.length > HISTORY_MAX) past.shift();
  future.length = 0;
  updateHistoryButtons();
}

export function applyPlaceState(st){
  S.place = st.place.map(p => ({...p}));
  S.sel = st.sel;
  syncLayerControls();
  /* Unconditionally: the canvas depends on the base's box in either mode, and
     an undo can change either layer. */
  replan();
  syncPlacementFields();
  announcePosition();
  updateHistoryButtons();
}

export function undo(){
  endChange();
  if (!past.length) return false;
  future.push(placeState());
  applyPlaceState(past.pop());
  return true;
}

export function redo(){
  endChange();
  if (!future.length) return false;
  past.push(placeState());
  applyPlaceState(future.pop());
  return true;
}

/* An open gesture is undoable before it is committed: undo() closes it first.
   Reading past.length alone made the button claim there was nothing to undo
   while the very same action was available on Ctrl+Z, which is a worse lie than
   simply not having the button. */
export function canUndo(){
  return past.length > 0 || !!(gesture && !samePlace(gesture.before, placeState()));
}

export function updateHistoryButtons(){
  $("#undo").disabled = !canUndo();
  $("#redo").disabled = future.length === 0;
}

/* Everything that moves a layer ends here: the drag, the arrows, and a typed
   coordinate. Moving the base changes the canvas in either mode, and in "Fit
   both" so does moving the overlay; anything else would only make replan()
   restart the preview for no change.

   The fields are refreshed here rather than being left to the animation loop,
   so the number changes because the layer moved and not because a frame
   happened to be drawn -- requestAnimationFrame does not run in a background
   tab, and the loop is throttled well below the rate a key can repeat. */
export function placementChanged(){
  if (S.canvasMode === "fit" || S.sel === 0) replan();
  else syncPlacementFields();
  updateHistoryButtons();
}

export function nudge(dx, dy){
  const pos = layerPos(S.sel);
  if (!pos) return false;
  beginChange("nudge");
  setLayerPos(S.sel, pos.x + dx, pos.y + dy);
  placementChanged();
  announcePosition();
  return true;
}

export function announcePosition(){
  const pos = layerPos(S.sel);
  if (!pos) return;
  $("#announce").textContent = `${S.sel ? "Overlay" : "Base"} at ${
    Math.round(pos.x)}, ${Math.round(pos.y)}`;
}

/* Also called by an undo, which can restore a different layer's selection than
   the one the controls are currently showing. */
export function syncLayerControls(){
  $("#lyBase").setAttribute("aria-pressed", S.sel === 0 ? "true" : "false");
  $("#lyOver").setAttribute("aria-pressed", S.sel === 1 ? "true" : "false");
  const pct = Math.round(S.place[S.sel].scale*100);
  $("#sc").value = pct; $("#scv").textContent = pct + "%";
}

/* The fields follow every other way a layer can move -- dragging, the arrows,
   Recenter, the size slider, a swap -- so they are refreshed from the state
   rather than by each of those in turn. Never while the field has focus, or it
   would rewrite what someone is in the middle of typing. */
export function syncPlacementFields(){
  const pos = layerPos(S.sel), px = $("#px"), py = $("#py"), live = !!pos;
  if (px.disabled === live){ px.disabled = !live; py.disabled = !live; }
  if (!pos) return;
  for (const [el, v] of [[px, Math.round(pos.x)], [py, Math.round(pos.y)]]){
    if (document.activeElement !== el && el.value !== String(v)) el.value = String(v);
  }
}

/* The preview is a canvas, so without this it is an unlabelled blank to anyone
   not looking at it. */
export function updateStageLabel(){
  const [A,B] = S.src, plan = S.plan;
  let text;
  if (!A && !B) text = "Preview. Nothing loaded yet.";
  /* setAttribute takes a raw string -- esc() here would have a screen reader
     read out "&amp;" from any filename containing an ampersand. */
  else if (!A || !B) text = `Preview of ${(A||B).name}. Waiting for a second file.`;
  else text = `Preview: ${B.name} over ${A.name}` + (plan
    ? `, ${plan.count} frames, ${(plan.outDur/1000).toFixed(2)} seconds.` : ".");
  if (stage.getAttribute("aria-label") !== text) stage.setAttribute("aria-label", text);
}

/* `view` is the state to composite from. The preview passes nothing and reads S
   live, which is what it wants. A render passes a snapshot taken when it began,
   so that nothing the user touches while it runs can land halfway through the
   output — see renderView() and #27. */
export function composite(ctx, W, H, t, dx, dy, forceOpaque, view){
  const v = view || S;
  const [A,B] = v.src, plan = v.plan;
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.clearRect(0,0,W,H);
  if (v.bg === "solid" || forceOpaque){ ctx.fillStyle = v.bgColor; ctx.fillRect(0,0,W,H); }
  if (!A) return;
  const ab = layerBox(0, v);
  ctx.drawImage(A.frames[frameAt(A, t, plan?plan.kA:1)].bitmap,
                dx + ab.x, dy + ab.y, ab.w, ab.h);
  if (!B) return;
  const bb = layerBox(1, v);
  ctx.globalCompositeOperation = v.blend; ctx.globalAlpha = v.opacity;
  ctx.drawImage(B.frames[frameAt(B, t, plan?plan.kB:1)].bitmap,
                dx + bb.x, dy + bb.y, bb.w, bb.h);
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

/* Everything composite() reads, frozen. src is copied so a slot being replaced
   cannot change which sources a running render is drawing. */
export function renderView(plan){
  return {plan, src: S.src.slice(), bg: S.bg, bgColor: S.bgColor, blend: S.blend,
          opacity: S.opacity, canvasMode: S.canvasMode,
          place: S.place.map(p => ({...p}))};
}

/* Shared with the worker, which builds an OffscreenCanvas instead of an
   element but must configure it identically -- the two are required to produce
   the same bytes, and imageSmoothingEnabled or the alpha flag differing between
   them would show up as a quiet difference in the output rather than an error.
   Works on either kind of canvas. */
export function renderContext(canvas, opaque){
  const cx = canvas.getContext("2d", {willReadFrequently:true, alpha:!opaque});
  cx.imageSmoothingEnabled = true;
  return cx;
}

/* The scale from output pixels to the geometry composite() draws in. Shared for
   the same reason: the preview, the main-thread export and the worker all have
   to place a layer in the same place. */
export function compositeInto(cx, W, H, g, t, opaque, view){
  cx.save();
  cx.scale(W/g.w, H/g.h);
  composite(cx, g.w, g.h, t, g.dx, g.dy, opaque, view);
  cx.restore();
}

export function makeRenderCanvas(W, H, g, opaque, view){
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const cx = renderContext(c, opaque);
  return { c, cx, at(t){ compositeInto(cx, W, H, g, t, opaque, view); } };
}

/* What composite() needs, reduced to things structured clone can carry. The
   ImageBitmaps are deliberately *not* transferred: the preview draws from those
   same bitmaps every frame and disposeSource owns them (#26), so the worker
   gets clones and the main thread keeps what it had. That copy is the price of
   this whole change, and it is transient -- the clones die with the worker. */
export function workerView(view){
  return {
    bg: view.bg, bgColor: view.bgColor, blend: view.blend,
    opacity: view.opacity, canvasMode: view.canvasMode,
    place: view.place.map(p => ({...p})),
    /* Only kA and kB are read, and a whole plan would drag its frame arrays
       across for nothing. */
    plan: {kA: view.plan.kA, kB: view.plan.kB},
    src: view.src.map(s => s && {
      width: s.width, height: s.height, starts: s.starts,
      duration: s.duration, static: s.static,
      frames: s.frames.map(f => ({bitmap: f.bitmap})),
    }),
  };
}

export let busy = false;      // set for the whole of a render, cleared in its finally
export let lastGifPalette = null;  // {exact, colors} from the most recent GIF export
export let cancelling = false;

/* Thrown to unwind a render the user asked to stop. Marked rather than matched
   on its message, so it stays distinguishable from a genuine failure. */
export class Cancelled extends Error {
  constructor(){ super("Render cancelled."); this.cancelled = true; }
}

/* Yield, then bail if the user pressed Cancel while we were away. Every encode
   loop already paused here to keep the page responsive, which is exactly where
   a render can be stopped without leaving half-written state behind. */
export async function breathe(ms){
  await idle(ms);
  if (cancelling) throw new Cancelled();
}
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

export const MODE_TEXT = {
  lcm:"Both loop a whole number of times, so the seam is invisible and nothing is retimed.",
  stretch:"The overlay's frame delays are scaled so one of its cycles lands exactly on the base's.",
  shortest:"Output stops when the shorter one ends. The longer gets cut mid-cycle.",
  longest:"Output runs to the longer one. The shorter repeats and may cut mid-cycle."
};

/* A replan while a render is running would leave composite() sampling from a
   different timeline than the one being written -- the frames come from S.plan's
   retiming, the durations from the plan the encoder captured. Defer it instead;
   the render finishes against consistent state and the new plan lands after. */
export let queuedReplan = false;

/* A module may read another module's binding but never assign it, so the few
   places that used to poke these flags call through here instead. Each name is
   the moment it marks rather than the variable it sets, which reads better at
   the call site anyway. */
export function renderStarted(){ busy = true; cancelling = false; lastGifPalette = null; }
export function renderFinished(){ busy = false; cancelling = false; }
export function requestCancel(){ cancelling = true; }
export function setLastGifPalette(p){ lastGifPalette = p; }
export function takeQueuedReplan(){
  if (!queuedReplan) return false;
  queuedReplan = false;
  return true;
}
/* Returns the new playing state; the caller owns the button's label. */
export function togglePlay(){
  if (S.playing) pausedAt = (performance.now() - S.t0) % (S.plan ? S.plan.outDur : 1000);
  else S.t0 = performance.now() - pausedAt;
  S.playing = !S.playing;
  return S.playing;
}
export function resetZoom(){ zoom = null; }
export function replan(){
  if (busy){ queuedReplan = true; return; }
  const [A,B] = S.src, R = $("#readout");
  if (!A || !B){
    S.plan = null; $("#render").disabled = true; $("#syncNote").textContent = "";
    R.innerHTML = '<div class="idle">Load two files to see the plan.</div>';
    updateStageLabel(); syncPlacementFields();
    return;
  }
  const plan = planTimeline(A, B, S.sync, S.maxFrames);
  S.plan = plan; S.t0 = performance.now();
  $("#render").disabled = false;
  $("#syncNote").textContent = MODE_TEXT[plan.mode];
  const g = geometry();
  const ow = Math.round(g.w*S.outScale), oh = Math.round(g.h*S.outScale);
  $("#dims").textContent = ow + "×" + oh;
  const heavy = plan.count*ow*oh > 40e6;
  const dur = s => s.static ? "still" : (s.duration/1000).toFixed(2)+"s";
  R.innerHTML = `
    <div class="out">
      <span class="k">Output</span>
      <span class="fig">${(plan.outDur/1000).toFixed(2)}<span class="u">s</span></span>
      <span class="fig">${plan.count}<span class="u">frames</span></span>
      <span class="fig">${ow}×${oh}</span>
    </div>
    <div class="in">
      <span class="base"><span class="k">Base</span><b>${dur(A)}</b> · ${
        A.frames.length} frames · ${esc(A.kind)}</span>
      <span class="over"><span class="k">Overlay</span><b>${dur(B)}</b> · ${
        B.frames.length} frames · ${esc(B.kind)}${
        plan.kB!==1?` · retimed ×${(1/plan.kB).toFixed(3)}`:""}</span>
    </div>
    <div class="status ${heavy?"warn":"ok"}">${plan.resampled
      ? "Resampled to fit the frame budget — raise it for exact timing."
      : heavy ? "Large output. Drop the output scale or frame budget."
      : "Exact frame boundaries preserved."}</div>`;
  updateStageLabel(); syncPlacementFields();
}
