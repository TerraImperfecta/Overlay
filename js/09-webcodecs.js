import { $ } from "./util.js";
import { breathe } from "./11a-state.js";
import { makeRenderCanvas } from "./11c-compositing.js";

/* =====================================================================
   9. WEBCODECS ENCODE DRIVER
   ===================================================================== */
export async function encodeWithVideoEncoder(fmt, W, H, plan, geom, quality, say, view){
  const R = makeRenderCanvas(W, H, geom, true, view);
  const fps = Math.max(1, plan.count / (plan.outDur/1000));
  const bitrate = Math.round(W * H * fps * (0.03 + 0.22*quality));
  const chunks = []; let description = null, failure = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (!description && meta && meta.decoderConfig && meta.decoderConfig.description)
        description = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({data, key: chunk.type === "key", timestamp: chunk.timestamp});
    },
    error: e => { failure = e; }
  });
  enc.configure(Object.assign({
    codec: fmt.codec, width: W, height: H, bitrate,
    framerate: Math.max(1, Math.round(fps)), latencyMode: "quality"
  }, fmt.config || {}));

  try {
  for (let i = 0; i < plan.count; i++){
    if (failure) throw failure;
    R.at(plan.times[i] + 1);
    const vf = new VideoFrame(R.c, {
      timestamp: plan.times[i] * 1000, duration: plan.delaysMs[i] * 1000 });
    enc.encode(vf, {keyFrame: i === 0 || i % 60 === 0});
    vf.close();
    while (enc.encodeQueueSize > 6){ await breathe(3); if (failure) throw failure; }
    if (i % 8 === 0){ say(`Encoding ${i+1}/${plan.count}`); await breathe(); }
  }
  await enc.flush();
  } finally {
    /* Cancelling, or any thrown failure, used to leave the encoder open. */
    if (enc.state !== "closed") enc.close();
  }
  if (failure) throw failure;
  if (!chunks.length) throw new Error("The encoder produced no frames.");

  chunks.sort((a,b) => a.timestamp - b.timestamp);
  const samples = chunks.map((c,i) => ({
    data: c.data, key: c.key,
    timestamp: Math.round(c.timestamp/1000),
    duration: plan.delaysMs[Math.min(i, plan.delaysMs.length-1)]
  }));
  samples[0].key = true;
  return {samples, description};
}

/* Which MIME each still output should decode back as. ImageDecoder reads APNG
   under "image/png"; there is no separate animated type to ask for. */
export const VERIFY_MIME = {gif:"image/gif", webp:"image/webp", apng:"image/png", avif:"image/avif"};

/* Returns {ok, reason, frames} rather than a bare boolean, because the still
   formats have no fallback to substitute: if verification fails the user gets
   an error, and "decoded 5 frames instead of 6" is a far better error than
   "didn't work". */
export async function verifyBlob(blob, kind, expectFrames){
  const mime = VERIFY_MIME[kind];
  if (mime){
    /* No ImageDecoder means unverifiable, which is not the same as bad. */
    if (typeof ImageDecoder === "undefined") return {ok:true, reason:"unverified"};
    let dec;
    try {
      dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime });
      await dec.tracks.ready;
      /* frameCount is only final once the whole stream has been read. */
      try { await dec.completed; } catch {}
      const {image} = await dec.decode({frameIndex:0});
      image.close();
      const frames = dec.tracks.selectedTrack.frameCount;
      dec.close();
      if (expectFrames && frames !== expectFrames)
        return {ok:false, frames, reason:`decoded ${frames} frames instead of ${expectFrames}`};
      return {ok:true, frames};
    } catch (e){
      try { if (dec) dec.close(); } catch {}
      return {ok:false, reason:"didn't decode here"};
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement("video");
    v.muted = true; v.preload = "metadata"; v.src = url;
    const ok = await new Promise(res => {
      v.onloadedmetadata = () => res(v.videoWidth > 0);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 4000);
    });
    return ok ? {ok:true} : {ok:false, reason:"didn't play back here"};
  } finally { URL.revokeObjectURL(url); }
}
