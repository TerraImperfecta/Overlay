import { $ } from "./util.js";
import { S } from "./11a-state.js";
import { layerPos, setLayerPos } from "./11b-geometry.js";
import { announcePosition, syncLayerControls, syncPlacementFields } from "./11e-controls.js";
import { replan } from "./11g-plan.js";

/* =====================================================================
   11d. PLACEMENT HISTORY
   ---------------------------------------------------------------------
   Undo and redo, for placement only (#62). Every way a layer can move --
   the drag, the arrows, a typed coordinate -- funnels through
   placementChanged, which is also what keeps the history honest about
   what counts as one step.
   ===================================================================== */

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
