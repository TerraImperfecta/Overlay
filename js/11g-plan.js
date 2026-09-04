import { $, esc } from "./util.js";
import { lcm, planTimeline } from "./03-timeline.js";
import { S, busy } from "./11a-state.js";
import { geometry } from "./11b-geometry.js";
import { syncPlacementFields, updateStageLabel } from "./11e-controls.js";

/* =====================================================================
   11g. THE PLAN
   ---------------------------------------------------------------------
   Turning two sources into one merged timeline, and reporting what that
   merge did. Deferred while a render is running, so the render finishes
   against consistent state.
   ===================================================================== */

/* Set when a replan is asked for mid-render and honoured once that render
   finishes. It lives here rather than with the other render flags because a
   module may read another module's binding but never assign it, and replan()
   below is what sets it. */
/* A replan while a render is running would leave composite() sampling from a
   different timeline than the one being written -- the frames come from S.plan's
   retiming, the durations from the plan the encoder captured. Defer it instead;
   the render finishes against consistent state and the new plan lands after. */
export let queuedReplan = false;

export function takeQueuedReplan(){
  if (!queuedReplan) return false;
  queuedReplan = false;
  return true;
}

export const MODE_TEXT = {
  lcm:"Both loop a whole number of times, so the seam is invisible and nothing is retimed.",
  stretch:"The overlay's frame delays are scaled so one of its cycles lands exactly on the base's.",
  shortest:"Output stops when the shorter one ends. The longer gets cut mid-cycle.",
  longest:"Output runs to the longer one. The shorter repeats and may cut mid-cycle."
};

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
