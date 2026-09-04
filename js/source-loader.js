import { $ } from "./util.js";
import { flattenGIF, parseGIF } from "./gif-decoder.js";

/* =====================================================================
   UNIVERSAL SOURCE LOADER
   ===================================================================== */
export const VIDEO_FPS = 20, VIDEO_MAX_FRAMES = 200, VIDEO_MAX_EDGE = 640;

export async function loadSource(file, onProgress){
  const name = file.name || "clip";
  const type = (file.type || "").toLowerCase();
  const ext = name.split(".").pop().toLowerCase();
  const isVideo = type.startsWith("video/") || ["mp4","webm","mov","m4v","ogv","mkv"].includes(ext);
  let frames, width, height, kind;

  let note = "";
  if (isVideo){
    ({frames, width, height} = await decodeVideo(file, onProgress)); kind = "video";
  } else if (type === "image/gif" || ext === "gif"){
    const gif = parseGIF(await file.arrayBuffer());
    width = gif.width; height = gif.height;
    const flat = flattenGIF(gif);
    frames = [];
    for (let i = 0; i < flat.length; i++){
      frames.push({ bitmap: await createImageBitmap(new ImageData(flat[i].data, width, height)),
                    delay: flat[i].delay });
      if (onProgress && i % 8 === 0) onProgress(`Decoding ${i+1}/${flat.length}`);
    }
    kind = "gif";
  } else {
    ({frames, width, height, kind, note = ""} = await decodeImage(file, type, ext, onProgress));
  }
  if (!frames.length) throw new Error("Nothing decodable in that file.");

  const starts = []; let t = 0;
  for (const f of frames){ starts.push(t); t += f.delay; }
  const isStatic = frames.length === 1;
  return { name, kind, width, height, frames, starts,
           duration: isStatic ? 0 : (t || 100), static: isStatic, thumb:null, meta: note };
}

export async function decodeImage(file, type, ext, onProgress){
  const guess = type || ({webp:"image/webp", avif:"image/avif", png:"image/png",
                          jpg:"image/jpeg", jpeg:"image/jpeg", jxl:"image/jxl"}[ext] || "");
  if (typeof ImageDecoder !== "undefined" && guess){
    let supported = true;
    try { supported = await ImageDecoder.isTypeSupported(guess); } catch { supported = false; }
    if (supported){
      const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: guess });
      try {
        await dec.tracks.ready;
        try { await dec.completed; } catch {}
        const track = dec.tracks.selectedTrack;
        const count = Math.max(1, Math.min(track.frameCount || 1, 600));
        const frames = []; let width = 0, height = 0;
        for (let i = 0; i < count; i++){
          const {image} = await dec.decode({ frameIndex: i });
          width = image.displayWidth; height = image.displayHeight;
          const bitmap = await createImageBitmap(image);
          const ms = image.duration ? Math.max(20, Math.round(image.duration/1000)) : 100;
          image.close();
          frames.push({bitmap, delay: ms});
          if (onProgress && i % 8 === 0) onProgress(`Decoding ${i+1}/${count}`);
        }
        dec.close();
        return {frames, width, height, kind: guess.split("/")[1]};
      } catch { try { dec.close(); } catch {} }
    }
  }
  /* No ImageDecoder, or it refused the type. createImageBitmap gives back a
     single frame, so an animated WebP, APNG or AVIF silently arrives as its
     first frame -- see #19, which is WebKit today. Say so in the slot rather
     than leaving the user to conclude the tool is broken. */
  const bitmap = await createImageBitmap(file);
  const animatable = ["webp","avif","png","apng"].includes(ext) ||
                     /^image\/(webp|avif|png|apng)$/.test(guess);
  return { frames:[{bitmap, delay:100}], width:bitmap.width, height:bitmap.height, kind:"still",
           note: (animatable && typeof ImageDecoder === "undefined")
                 ? "first frame only — no ImageDecoder" : "" };
}

export async function decodeVideo(file, onProgress){
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error("This browser can't decode that video."));
    });
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (!dur) throw new Error("Video has no readable duration.");
    const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
    const W = Math.max(1, Math.round(v.videoWidth*scale));
    const H = Math.max(1, Math.round(v.videoHeight*scale));
    const count = Math.min(VIDEO_MAX_FRAMES, Math.max(1, Math.round(dur*VIDEO_FPS)));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const cx = c.getContext("2d");
    const frames = [];
    for (let i = 0; i < count; i++){
      const t = Math.min(dur - 0.001, (i*dur)/count);
      await new Promise(res => { v.onseeked = res; v.currentTime = t; });
      cx.drawImage(v, 0, 0, W, H);
      frames.push({ bitmap: await createImageBitmap(c),
                    delay: Math.max(20, Math.round(dur/count*1000)) });
      if (onProgress && i % 4 === 0) onProgress(`Sampling ${i+1}/${count}`);
    }
    return {frames, width:W, height:H};
  } finally { URL.revokeObjectURL(url); v.src = ""; }
}
