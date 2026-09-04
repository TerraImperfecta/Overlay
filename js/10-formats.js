import { $, esc } from "./util.js";

/* =====================================================================
   10. FORMAT REGISTRY
   ===================================================================== */
export const AV1_CODECS  = ["av01.0.08M.08", "av01.0.05M.08", "av01.0.04M.08"];
export const H264_CODECS = ["avc1.640028", "avc1.4D0032", "avc1.42E01E"];
export const VP9_CODECS  = ["vp09.00.10.08"];
export const VP8_CODECS  = ["vp8"];

export async function firstSupportedCodec(list){
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of list){
    try {
      const r = await VideoEncoder.isConfigSupported({codec, width:256, height:256,
        bitrate:1000000, framerate:30});
      if (r && r.supported) return codec;
    } catch {}
  }
  return null;
}

export const FORMATS = [];
export async function buildFormats(){
  FORMATS.length = 0;
  FORMATS.push({id:"gif", label:"GIF", ext:"gif", kind:"gif",
    note:"Universal, but 256 colours, 1-bit alpha and 10 ms timing steps."});

  const probe = document.createElement("canvas"); probe.width = probe.height = 8;
  const webpOK = await new Promise(r => probe.toBlob(b => r(!!b && b.type==="image/webp"), "image/webp", .8));
  if (webpOK) FORMATS.push({id:"webp", label:"Animated WebP", ext:"webp", kind:"webp", quality:true,
    note:"Best default. Full colour, real alpha, millisecond timing, far smaller than GIF."});

  const pngOK = await new Promise(r => probe.toBlob(b => r(!!b && b.type==="image/png"), "image/png"));
  if (pngOK) FORMATS.push({id:"apng", label:"APNG", ext:"png", kind:"apng",
    note:"Lossless with 8-bit alpha. Large files — best for short, flat-colour loops."});

  const av1  = await firstSupportedCodec(AV1_CODECS);
  const h264 = await firstSupportedCodec(H264_CODECS);
  const vp9  = await firstSupportedCodec(VP9_CODECS);
  const vp8  = await firstSupportedCodec(VP8_CODECS);

  if (av1) FORMATS.push({id:"avif", label:"Animated AVIF", ext:"avif", kind:"iso", codec:av1,
    quality:true, avif:true, entry:"av01",
    brands:["avis","avif","av01","miaf","MA1B","msf1","iso8"],
    note:"AV1 frames muxed into an image-sequence container. Smallest of the lot, but opaque only — a solid background is used. macOS Preview and Quick Look can't open animated AVIF."});
  if (av1) FORMATS.push({id:"mp4-av1", label:"MP4 · AV1", ext:"mp4", kind:"iso", codec:av1,
    quality:true, entry:"av01", brands:["isom","iso2","av01","mp41"],
    note:"Encoded offline at exact frame times. No transparency."});
  if (h264) FORMATS.push({id:"mp4-h264", label:"MP4 · H.264", ext:"mp4", kind:"iso", codec:h264,
    quality:true, entry:"avc1", brands:["isom","iso2","avc1","mp41"], config:{avc:{format:"avc"}},
    note:"Most widely playable video option. No transparency."});
  if (vp9) FORMATS.push({id:"webm-vp9", label:"WebM · VP9", ext:"webm", kind:"ebml", codec:vp9,
    quality:true, codecId:"V_VP9", note:"Encoded offline at exact frame times. No transparency."});
  if (av1) FORMATS.push({id:"webm-av1", label:"WebM · AV1", ext:"webm", kind:"ebml", codec:av1,
    quality:true, codecId:"V_AV1", note:"Encoded offline at exact frame times. No transparency."});
  if (vp8) FORMATS.push({id:"webm-vp8", label:"WebM · VP8", ext:"webm", kind:"ebml", codec:vp8,
    quality:true, codecId:"V_VP8", note:"Encoded offline at exact frame times. No transparency."});

  /* A browser with no VideoEncoder used to be offered MediaRecorder entries
     here. They are gone (#59). Measured against a plan with boundaries of
     100/48/52/96/30 ms, a recording came back flat at ~67 ms -- a uniform
     resample at the capture rate, drifting up to 30 ms -- because the frames
     land on the capture clock rather than the merged timeline. Preserving those
     boundaries is the one thing this tool exists to do, and no label on a
     dropdown makes an option that cannot do it worth offering.

     Nobody is left without an export: GIF and APNG need no browser codec and
     keep exact timing, on every engine. MediaRecorder survives only as the
     repair in render() for a coded mux that fails its own verification, where
     the alternative is not a worse file but no file. */

  const sel = $("#fmt");
  sel.innerHTML = FORMATS.map(f => `<option value="${f.id}">${esc(f.label)}</option>`).join("");
  sel.value = FORMATS.some(f => f.id === "webp") ? "webp" : "gif";
  onFormat();
}

/* Which format the select is showing, and the controls that follow from it.
   Both lived elsewhere -- currentFormat in the exporter, onFormat in the UI
   wiring -- which made this module depend on the UI that depends on it. They
   are about the registry, so they belong here and the cycle goes away. */
export const currentFormat = () => FORMATS.find(f => f.id === $("#fmt").value) || FORMATS[0];

export function onFormat(){
  const f = currentFormat(); if (!f) return;
  $("#fmtNote").textContent = f.note;
  $("#qualityCtl").hidden = !f.quality;
  $("#render").textContent = "Render";
}
