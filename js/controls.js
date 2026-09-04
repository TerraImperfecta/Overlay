import { $ } from "./util.js";
import { layerPos } from "./geometry.js";
import { S, stage } from "./state.js";
import { el } from "./webm.js";

/* =====================================================================
   CONTROLS AND ANNOUNCEMENTS
   ---------------------------------------------------------------------
   Pushing state back out into the controls that display it, and saying
   what changed for anyone not looking at the screen. Called from wherever
   placement moves, so it must not import from those callers.
   ===================================================================== */

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
