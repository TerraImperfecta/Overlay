import { $, esc, idle } from "./util.js";
import { gifFromFrames, makeGifWorker, runGifWorker } from "./04-gif-encoder.js";
import { anmfPayload, muxWebP } from "./05-webp.js";
import { muxAPNG } from "./06-apng.js";
import { av1ConfigRecord, box, muxISOBMFF } from "./07-isobmff.js";
import { muxWebM } from "./08-webm.js";
import { VERIFY_MIME, encodeWithVideoEncoder, verifyBlob } from "./09-webcodecs.js";
import { currentFormat } from "./10-formats.js";
import {
  Cancelled,
  S,
  breathe,
  busy,
  cancelling,
  lastGifPalette,
  renderFinished,
  renderStarted,
  setLastGifPalette
} from "./11a-state.js";
import { geometry } from "./11b-geometry.js";
import { makeRenderCanvas, renderView, workerView } from "./11c-compositing.js";
import { loop } from "./11f-preview.js";
import { replan, takeQueuedReplan } from "./11g-plan.js";

/* =====================================================================
   12. EXPORT
   ===================================================================== */

export async function render(){
  if (busy || !S.plan) return;
  renderStarted();
  const btn = $("#render"), out = $("#out"), stop = $("#cancel");
  btn.disabled = true; out.innerHTML = "";
  stop.hidden = false; stop.disabled = false; stop.textContent = "Cancel";
  const say = m => { btn.textContent = m; };
  const fmt = currentFormat();
  try {
    const plan = S.plan, view = renderView(plan), g = geometry(view);
    const W = Math.max(2, Math.round(g.w*S.outScale) & ~1);
    const H = Math.max(2, Math.round(g.h*S.outScale) & ~1);
    let blob, warning = "";

    blob = await (EXPORTERS[fmt.kind] || EXPORTERS.coded)(fmt,W,H,g,plan,say,view);

    /* Every format is verified before it is offered, not just the coded ones. */
    say("Verifying");
    const still = !!VERIFY_MIME[fmt.kind];
    const check = await verifyBlob(blob, still ? fmt.kind : (fmt.avif ? "avif" : "video"),
                                   plan.count);
    if (!check.ok){
      if (still)
        throw new Error(`The ${fmt.label} we produced ${check.reason}.`);
      if (fmt.avif)
        throw new Error("The muxed AVIF didn't decode here. Try MP4 · AV1 instead.");
      /* The last use of MediaRecorder. It is no longer offered as a format
         (#59) because its frame times follow the capture clock rather than the
         merged timeline -- but here the choice is not between a worse file and
         a better one, it is between a worse file and none, since our own mux
         has just produced something that will not play. Said plainly, because
         the user asked for exact timing and is not getting it. */
      const fallback = ["video/webm;codecs=vp9","video/webm;codecs=vp8"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
      if (!fallback) throw new Error("The muxed file didn't play back here.");
      warning = "Muxed file failed verification — recorded in real time instead, " +
                "so its frame times follow the capture clock, not the merged timeline.";
      blob = await exportRecorder({mime:fallback}, W, H, g, plan, say, view);
      /* The substitute gets checked too. Offering a file we already know is
         broken would defeat the point of checking at all. */
      /* No frame count: real-time capture builds its own from the wall clock,
         so holding it to plan.count would fail it for the wrong reason. */
      if (!(await verifyBlob(blob, "video")).ok)
        throw new Error("Neither the muxed file nor the real-time recording played back here.");
    }

    const url = URL.createObjectURL(blob);
    const kb = blob.size/1024;
    const asVideo = fmt.ext === "mp4" || fmt.ext === "webm";
    out.innerHTML = `${asVideo
        ? `<video class="prev" src="${url}" autoplay loop muted playsinline></video>`
        : `<img class="prev" src="${url}" alt="Merged result">`}
      <div class="readout" style="margin-top:8px">
        <b>${W}×${H}</b> · ${plan.count} frames · ${(plan.outDur/1000).toFixed(2)}s ·
        <b>${kb>1024 ? (kb/1024).toFixed(2)+" MB" : Math.round(kb)+" KB"}</b>
        ${warning ? `<div class="warn">${esc(warning)}</div>` : ""}
        ${lastGifPalette ? `<div class="${lastGifPalette.exact ? "ok" : "warn"}">${
          lastGifPalette.exact
            ? `Exact palette · ${lastGifPalette.colors} colours, none lost`
            : `Palette reduced to ${lastGifPalette.colors} colours`}</div>` : ""}
      </div>
      <a class="dl" href="${url}" download="overlay.${fmt.ext}">Download ${fmt.ext.toUpperCase()}</a>`;
  } catch (e){
    /* A cancellation is something the user asked for, not a failure to report
       as one. Anything else is. */
    out.innerHTML = e && e.cancelled
      ? `<div class="readout">Render cancelled.</div>`
      : `<div class="readout warn">Couldn't render: ${esc(e.message || e)}</div>`;
  } finally {
    renderFinished();
    $("#cancel").hidden = true;
    $("#render").disabled = false; $("#render").textContent = "Render";
    /* Cleared before the queued replan runs, so it is not deferred forever, and
       inside finally so a thrown render cannot leave the app permanently stuck. */
    if (takeQueuedReplan()) replan();
  }
}

export async function exportGIF(W,H,g,plan,say,view){
  /* The view was optional, and composite() fell back to reading S live. There
     is no S in a worker, so one is taken here instead -- which is also what #27
     wants of a render: a snapshot nothing the user does can change halfway. */
  const v = view || renderView(plan);
  const job = {W, H, g, count: plan.count, times: Array.from(plan.times),
               delaysCs: Array.from(plan.delaysCs),
               needsAlpha: v.bg === "transparent"};

  /* Compositing goes across too now, not just the encode. It was 81% of the
     loop and the loop was 83% of the block the user actually feels (#63, #72),
     so leaving it here would have left most of the freeze behind. */
  const worker = makeGifWorker();
  let out;
  if (worker){
    try { out = await runGifWorker(worker, {...job, view: workerView(v)}, say); }
    finally { worker.terminate(); }
  } else {
    /* No worker: the same functions, on this thread, pausing often enough to
       keep the page answering. */
    const R = makeRenderCanvas(W,H,g,false,v);
    const rgba = [];
    for (let i=0;i<plan.count;i++){
      R.at(plan.times[i]+1);
      rgba.push(R.cx.getImageData(0,0,W,H).data);
      if (i%8===0){ say(`Compositing ${i+1}/${plan.count}`); await breathe(); }
    }
    out = await gifFromFrames({...job, rgba}, async text => { say(text); await breathe(); });
  }
  /* Which palette path ran is only knowable in here, and the readout wants it. */
  setLastGifPalette(out.palette);
  return new Blob([out.bytes], {type:"image/gif"});
}

export async function exportWebP(W,H,g,plan,say,view){
  const R = makeRenderCanvas(W,H,g,false,view);
  const parts = []; let hasAlpha = false;
  for (let i=0;i<plan.count;i++){
    R.at(plan.times[i]+1);
    const blob = await new Promise(r => R.c.toBlob(r, "image/webp", S.quality));
    if (!blob || blob.type !== "image/webp") throw new Error("This browser can't encode WebP.");
    const still = new Uint8Array(await blob.arrayBuffer());
    const {payload, hasAlpha:a} = anmfPayload(still, plan.delaysMs[i], W, H);
    parts.push(payload); hasAlpha = hasAlpha || a;
    if (i%4===0){ say(`Encoding ${i+1}/${plan.count}`); await breathe(); }
  }
  say("Muxing"); await breathe(16);
  return new Blob([muxWebP(W,H,parts,hasAlpha)], {type:"image/webp"});
}

export async function exportAPNG(W,H,g,plan,say,view){
  const R = makeRenderCanvas(W,H,g,false,view);
  const stills = [];
  for (let i=0;i<plan.count;i++){
    R.at(plan.times[i]+1);
    const d = R.cx.getImageData(0,0,1,1); d.data[3] = Math.min(d.data[3], 254);
    R.cx.putImageData(d,0,0);
    const blob = await new Promise(r => R.c.toBlob(r, "image/png"));
    stills.push(new Uint8Array(await blob.arrayBuffer()));
    if (i%4===0){ say(`Encoding ${i+1}/${plan.count}`); await breathe(); }
  }
  say("Muxing"); await breathe(16);
  return new Blob([muxAPNG(stills, plan.delaysMs, W, H)], {type:"image/png"});
}

export async function exportCoded(fmt, W, H, g, plan, say, view){
  const {samples, description} =
    await encodeWithVideoEncoder(fmt, W, H, plan, g, S.quality, say, view);
  say("Muxing"); await breathe(16);
  if (fmt.kind === "ebml"){
    const codecPrivate = fmt.codecId === "V_AV1"
      ? av1ConfigRecord(description, samples[0].data) : description;
    return new Blob([muxWebM({W,H,samples,codecId:fmt.codecId,codecPrivate})],
                    {type:"video/webm"});
  }
  const configBox = fmt.entry === "av01"
    ? box("av1C", av1ConfigRecord(description, samples[0].data))
    : box("avcC", description || new Uint8Array(0));
  const bytes = muxISOBMFF({W, H, samples, entryType: fmt.entry, configBox,
                            brands: fmt.brands, avif: !!fmt.avif});
  return new Blob([bytes], {type: fmt.avif ? "image/avif" : "video/mp4"});
}

export async function exportRecorder(fmt, W, H, g, plan, say, view){
  const R = makeRenderCanvas(W,H,g,true,view);
  const fps = Math.min(50, Math.max(10, Math.round(plan.count/(plan.outDur/1000))));
  const stream = R.c.captureStream(fps);
  const rec = new MediaRecorder(stream, {mimeType: fmt.mime,
    videoBitsPerSecond: Math.round(W*H*fps*0.15*(0.3+S.quality))});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  /* Exactly the plan, once. The loop count was a control belonging to the
     format entries that #59 removed; the repair below wants the clip the user
     asked for, not three of it. */
  const total = plan.outDur;
  R.at(1); rec.start();
  const t0 = performance.now();
  let cancelled = false;
  await new Promise(resolve => {
    (function step(){
      const elapsed = performance.now() - t0;
      /* Real-time capture, so this is the one path where cancelling actually
         saves the user the wall-clock time it would have taken. */
      if (cancelling){ cancelled = true; resolve(); return; }
      if (elapsed >= total){ resolve(); return; }
      say(`Recording ${(elapsed/1000).toFixed(1)}s / ${(total/1000).toFixed(1)}s`);
      R.at((elapsed % plan.outDur) + 1);
      requestAnimationFrame(step);
    })();
  });
  await idle(120);
  /* Stopped and torn down before unwinding, so a cancelled recording does not
     leave the capture stream running. */
  try { rec.stop(); await stopped; } catch {}
  stream.getTracks().forEach(t => t.stop());
  if (cancelled) throw new Cancelled();
  if (!chunks.length) throw new Error("The recorder produced no data.");
  return new Blob(chunks, {type: fmt.mime});
}

/* Dispatch by format, replacing a chain of ifs on fmt.kind. It is also the one
   seam a test has to swap an encoder for a broken one: a module-local call
   cannot be intercepted from outside, and reaching in to break the real muxer
   is how "the user is told rather than handed a bad file" gets tested. */
export const EXPORTERS = {
  gif:      (fmt,W,H,g,plan,say,view) => exportGIF(W,H,g,plan,say,view),
  webp:     (fmt,W,H,g,plan,say,view) => exportWebP(W,H,g,plan,say,view),
  apng:     (fmt,W,H,g,plan,say,view) => exportAPNG(W,H,g,plan,say,view),
  coded:    (fmt,W,H,g,plan,say,view) => exportCoded(fmt,W,H,g,plan,say,view),
};
