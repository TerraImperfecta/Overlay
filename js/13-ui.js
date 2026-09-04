import { $, esc } from "./util.js";
import { loadSource } from "./02-source-loader.js";
import { FORMATS, buildFormats, onFormat } from "./10-formats.js";
import { S, busy, requestCancel, stage } from "./11a-state.js";
import { setLayerPos } from "./11b-geometry.js";
import {
  beginChange,
  endChange,
  nudge,
  placementChanged,
  redo,
  undo,
  updateHistoryButtons
} from "./11d-history.js";
import { announcePosition, syncLayerControls } from "./11e-controls.js";
import { loop, resetZoom, stepZoom, togglePlay } from "./11f-preview.js";
import { replan } from "./11g-plan.js";
import { render } from "./12-export.js";

/* =====================================================================
   13. UI WIRING
   ===================================================================== */
export function renderSlot(i, statusText, isError){
  const slot = document.querySelector(`.slot[data-i="${i}"]`);
  const s = S.src[i];
  const label = `<span class="lbl">${i ? "Overlay" : "Base"}</span>`;
  const meta = statusText
    ? `<span class="meta${isError ? " warn" : ""}">${esc(statusText)}</span>`
    : `<span class="meta">${s ? esc(s.meta) : ""}</span>`;
  slot.innerHTML = label + (s
    ? `<img class="thumb" src="${s.thumb}" alt=""><span class="name">${esc(s.name)}</span>${meta}`
    : `<span class="hint">Drop a GIF, WebP, AVIF, APNG or video</span>${meta}`);
}

export function disposeSource(i){
  const s = S.src[i];
  if (!s) return;
  if (s.thumb && s.thumb.startsWith("blob:")) URL.revokeObjectURL(s.thumb);
  for (const f of s.frames){ try { f.bitmap.close(); } catch {} }
  S.src[i] = null;
}

export const loading = [false, false];
export async function accept(i, file){
  if (loading[i]) return;
  /* disposeSource() closes the previous source's ImageBitmaps. Doing that while
     a render is drawing from them throws mid-encode, so this one is refused
     rather than queued -- a file drop is easy to repeat, a lost render is not. */
  if (busy){ renderSlot(i, "Rendering — try again when it finishes.", true); return; }
  loading[i] = true;
  renderSlot(i, "Decoding…");
  try {
    const src = await loadSource(file, msg => renderSlot(i, msg));
    if (src.kind === "video"){
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src.frames[0].bitmap, 0, 0);
      src.thumb = c.toDataURL("image/png");
    } else src.thumb = URL.createObjectURL(file);
    /* loadSource may have left a note here explaining a fallback; keep it. */
    const note = src.meta;
    src.meta = `${src.width}×${src.height} · ${src.frames.length}f · ` +
               (src.static ? "still" : (src.duration/1000).toFixed(2)+"s") +
               (note ? " · " + note : "");
    disposeSource(i);
    S.src[i] = src;
    renderSlot(i); replan();
  } catch (e){
    renderSlot(i, e.message || "Couldn't read that file.", true);
  } finally { loading[i] = false; }
}

document.querySelectorAll(".slot").forEach(slot => {
  const i = +slot.dataset.i, input = $("#file"+i);
  const pick = () => { input.value = ""; input.click(); };
  slot.addEventListener("click", pick);
  slot.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); pick(); } });
  slot.addEventListener("dragover", e => { e.preventDefault(); slot.classList.add("hot"); });
  slot.addEventListener("dragleave", () => slot.classList.remove("hot"));
  slot.addEventListener("drop", e => {
    e.preventDefault(); slot.classList.remove("hot");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) accept(i, f);
  });
  input.addEventListener("change", () => { if (input.files[0]) accept(i, input.files[0]); });
  renderSlot(i);
});

/* =====================================================================
   Persisted settings
   =====================================================================
   Output settings only. Nothing derived from a loaded file is stored --
   not the sources, and not layer placement, whose coordinates are
   fractions of a base that will not be there next time.

   Every read and write is wrapped: a private window or a browser set to
   block site data can *throw* on access rather than returning null, and a
   stored preference must never be able to stop the app starting. */
export const SETTINGS_KEY = "overlay.settings.v1";

export function writeSettings(){
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      format: $("#fmt").value, quality: S.quality, outScale: S.outScale,
      opacity: S.opacity, sync: S.sync, bg: S.bg, bgColor: S.bgColor,
    }));
  } catch {}
}

/* Anything read back is treated as hostile: it may be from an older version,
   hand-edited, or corrupt. Each field is validated on its own, so one bad
   value costs that setting rather than all of them. */
export function readSettings(){
  let raw = null;
  try { raw = localStorage.getItem(SETTINGS_KEY); } catch { return {}; }
  let stored;
  try { stored = JSON.parse(raw); } catch { return {}; }
  if (!stored || typeof stored !== "object") return {};

  const out = {};
  const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi) ? v : undefined;
  const oneOf = (v, list) => list.includes(v) ? v : undefined;

  const q  = num(stored.quality, 0, 1);           if (q  !== undefined) out.quality  = q;
  const os = num(stored.outScale, .05, 4);        if (os !== undefined) out.outScale = os;
  const op = num(stored.opacity, 0, 1);           if (op !== undefined) out.opacity  = op;
  const sy = oneOf(stored.sync, [...$("#sync").options].map(o => o.value));
                                                  if (sy !== undefined) out.sync     = sy;
  const bg = oneOf(stored.bg, ["transparent","solid"]);
                                                  if (bg !== undefined) out.bg       = bg;
  if (typeof stored.bgColor === "string" && /^#[0-9a-f]{6}$/i.test(stored.bgColor))
    out.bgColor = stored.bgColor;
  if (typeof stored.format === "string") out.format = stored.format;
  return out;
}

/* Both halves of a segmented control, so a restored value looks selected
   rather than merely being selected. */
export function setSeg(aId, bId, useA){
  $(aId).setAttribute("aria-pressed", useA ? "true" : "false");
  $(bId).setAttribute("aria-pressed", useA ? "false" : "true");
}

export function applySettings(st){
  if (st.quality  !== undefined){ S.quality  = st.quality;
    $("#q").value = Math.round(st.quality*100); $("#qv").textContent = $("#q").value; }
  if (st.outScale !== undefined){ S.outScale = st.outScale;
    $("#osc").value = Math.round(st.outScale*100); $("#oscv").textContent = $("#osc").value+"%"; }
  if (st.opacity  !== undefined){ S.opacity  = st.opacity;
    $("#op").value = Math.round(st.opacity*100);  $("#opv").textContent = $("#op").value+"%"; }
  if (st.sync     !== undefined){ S.sync = st.sync; $("#sync").value = st.sync; }
  if (st.bg       !== undefined){ S.bg = st.bg; setSeg("#bgT", "#bgC", st.bg === "transparent"); }
  if (st.bgColor  !== undefined){ S.bgColor = st.bgColor; $("#bgColor").value = st.bgColor; }
}

/* Only after buildFormats(), and only if this browser can actually produce it.
   A format that is no longer on offer falls back to whatever buildFormats
   chose, rather than selecting an option that is not there. */
export function applyStoredFormat(id){
  if (!id || !FORMATS.some(f => f.id === id)) return false;
  $("#fmt").value = id;
  onFormat();
  return true;
}

export const bind = (id,ev,fn) => $(id).addEventListener(ev,fn);
bind("#sync","change", e => { S.sync = e.target.value; replan(); writeSettings(); });
bind("#maxf","input", e => { S.maxFrames = +e.target.value;
  $("#maxfv").textContent = S.maxFrames+" max"; replan(); });
bind("#blend","change", e => S.blend = e.target.value);
bind("#op","input", e => { S.opacity = e.target.value/100; $("#opv").textContent = e.target.value+"%";
  writeSettings(); });
bind("#sc","input", e => { beginChange("scale"); S.place[S.sel].scale = e.target.value/100;
  $("#scv").textContent = e.target.value+"%"; replan(); updateHistoryButtons(); });
bind("#sc","change", endChange);
bind("#osc","input", e => { S.outScale = e.target.value/100;
  $("#oscv").textContent = e.target.value+"%"; replan(); writeSettings(); });
bind("#q","input", e => { S.quality = e.target.value/100; $("#qv").textContent = e.target.value;
  writeSettings(); });
bind("#bgColor","input", e => { S.bgColor = e.target.value; writeSettings(); });
bind("#fmt","change", () => { onFormat(); writeSettings(); });


export function seg(aId,bId,aVal,bVal,set){
  const a = $(aId), b = $(bId);
  a.onclick = () => { a.setAttribute("aria-pressed","true"); b.setAttribute("aria-pressed","false"); set(aVal); };
  b.onclick = () => { b.setAttribute("aria-pressed","true"); a.setAttribute("aria-pressed","false"); set(bVal); };
}
seg("#cvBase","#cvFit","base","fit", v => { S.canvasMode = v; replan(); });
/* Selecting a layer moves the size slider onto it, so the control always shows
   the value it is about to change rather than the previous layer's. */
seg("#lyBase","#lyOver", 0, 1, i => { S.sel = i; syncLayerControls(); });

seg("#bgT","#bgC","transparent","solid", v => { S.bg = v; writeSettings(); });

bind("#swap","click", () => { S.src.reverse(); renderSlot(0); renderSlot(1); replan(); });
bind("#center","click", () => {
  beginChange("center");
  S.place[S.sel].x = .5; S.place[S.sel].y = .5; replan(); announcePosition();
  endChange();
});
bind("#render","click", render);
bind("#cancel","click", () => {
  if (!busy) return;
  requestCancel();
  const stop = $("#cancel");
  stop.disabled = true; stop.textContent = "Stopping…";
});
bind("#play","click", e => {
  e.target.textContent = togglePlay() ? "Pause" : "Play";
});

export let dragging = false, last = null;
stage.addEventListener("pointerdown", e => {
  /* The base alone can be moved now, so a second source is no longer required. */
  if (!S.src[S.sel]) return;
  dragging = true; last = e; stage.classList.add("drag");
  beginChange("drag");
  /* Last, and guarded. Capture is a convenience -- it keeps the drag alive past
     the edge of the canvas -- but it throws on a pointer id the browser does not
     recognise, and it used to sit ahead of beginChange, so that throw silently
     cost the drag its history entry while the drag itself carried on. Nothing
     after this line may depend on it. */
  try { stage.setPointerCapture(e.pointerId); } catch { /* drag without it */ }
});
stage.addEventListener("pointermove", e => {
  if (!dragging || !S.src[0]) return;
  const k = stage.width / stage.getBoundingClientRect().width;
  const p = S.place[S.sel];
  p.x += (e.clientX-last.clientX)*k / S.src[0].width;
  p.y += (e.clientY-last.clientY)*k / S.src[0].height;
  last = e;
  placementChanged();
});
stage.addEventListener("pointerup", () => {
  dragging = false; stage.classList.remove("drag"); endChange();
});

/* The drag handler was the only way to set a position, so without this a
   keyboard user could reach every control on the page and then not do the one
   thing the tool is for. */
export const NUDGE = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
stage.addEventListener("keydown", e => {
  const d = NUDGE[e.key];
  if (!d || e.metaKey || e.ctrlKey || e.altKey) return;
  const step = e.shiftKey ? 10 : 1;
  /* Only swallow the key if it actually moved something, so the page still
     scrolls with the arrows when there is nothing to move. */
  if (nudge(d[0]*step, d[1]*step)) e.preventDefault();
});

export const onXY = () => {
  beginChange("xy");
  if (!setLayerPos(S.sel, parseFloat($("#px").value), parseFloat($("#py").value))) return;
  placementChanged();
};
bind("#px","input", onXY);
bind("#py","input", onXY);
/* change fires on blur or Enter, which is where a typed number is finished. */
bind("#px","change", endChange);
bind("#py","change", endChange);

bind("#undo","click", undo);
bind("#redo","click", redo);

/* On the document rather than the preview, because there is nothing else on the
   page to undo -- but never inside a field, where the browser's own text undo is
   what someone pressing this means. */
document.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k !== "z" && k !== "y") return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName)) return;
  if ((k === "y" || e.shiftKey) ? redo() : undo()) e.preventDefault();
});

$("#zoomIn").addEventListener("click", () => stepZoom(1));
$("#zoomOut").addEventListener("click", () => stepZoom(-1));
$("#zoomFit").addEventListener("click", () => {
  resetZoom();
  $("#zoomFit").setAttribute("aria-pressed", "true");
});

$("#maxfv").textContent = S.maxFrames+" max";
$("#opv").textContent = "100%"; $("#scv").textContent = "100%";
$("#oscv").textContent = "100%"; $("#qv").textContent = "82";
/* Restore before the first plan so the readout is right immediately; the
   format waits for buildFormats() to say what this browser can offer. */
export const stored = readSettings();
applySettings(stored);
replan();
buildFormats().then(() => { applyStoredFormat(stored.format); });
loop();
