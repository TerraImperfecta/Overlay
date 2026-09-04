import { frameAt } from "./03-timeline.js";
import { S } from "./11a-state.js";
import { layerBox } from "./11b-geometry.js";

/* =====================================================================
   11c. COMPOSITING
   ---------------------------------------------------------------------
   Drawing the two layers into one frame, and the snapshots that let a
   render draw from state the user can no longer change (#27).

   composite, layerBox, frameAt, renderContext and compositeInto are also
   carried into the GIF worker as source (#63), so nothing here may
   reference anything the worker will not have.
   ===================================================================== */

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
