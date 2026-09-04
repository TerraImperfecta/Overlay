import { S } from "./11a-state.js";

/* =====================================================================
   11b. PLACEMENT GEOMETRY
   ---------------------------------------------------------------------
   Where each layer sits, and how big the output is because of it. Reads
   S and nothing else, so it is the bottom of this section's graph.
   ===================================================================== */

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
