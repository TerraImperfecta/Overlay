import { $, idle } from "./util.js";

/* =====================================================================
   APP STATE
   ---------------------------------------------------------------------
   Everything the rest of the app shares, and the DOM handles taken once
   at load.

   The mutable bindings live here with the functions that change them, and
   that pairing is not stylistic: a module may read another module's
   binding but never assign it, so a flag and its setter cannot be
   separated. Each transition is named for the moment it marks rather than
   the variable it sets.
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

/* A module may read another module's binding but never assign it, so the few
   places that used to poke these flags call through here instead. Each name is
   the moment it marks rather than the variable it sets, which reads better at
   the call site anyway. */
export function renderStarted(){ busy = true; cancelling = false; lastGifPalette = null; }

export function renderFinished(){ busy = false; cancelling = false; }

export function requestCancel(){ cancelling = true; }

export function setLastGifPalette(p){ lastGifPalette = p; }

