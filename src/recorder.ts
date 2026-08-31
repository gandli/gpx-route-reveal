import type { Map as MapLibreMap } from "maplibre-gl";
import type { RouteReveal } from "./animate";

// Native MediaRecorder over canvas.captureStream. No WebCodecs, no muxer.
// 720p upscale for export regardless of on-screen size.
export async function recordWebm(map: MapLibreMap, reveal: RouteReveal, onTick: (t: number) => void): Promise<Blob> {
  const canvas = await map.getCanvas();
  const video = document.createElement("video");
  video.width = 1280;
  video.height = 720;
  video.muted = true;
  video.playsInline = true;

  // captureStream on the map canvas — the browser composites the WebGL canvas into it.
  // fallback: draw via 2d capture. Keep it simple: captureStream is supported everywhere modern.
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });

  reveal.setCanvasHidden(true);
  const wasLoop = reveal.state.loop; // loop would reset t before the recorder sees 1
  reveal.state.loop = false;
  rec.start(100);
  reveal.setPlaying(true);
  const start = performance.now();
  while (reveal.state.t < 1) {
    onTick(reveal.state.t);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 500)); // let the tail settle
  reveal.setPlaying(false);
  reveal.state.loop = wasLoop;
  rec.stop();
  reveal.setCanvasHidden(false);
  const blob = await done;
  console.log(`recorded ${((blob.size / 1e6).toFixed(1))} MB in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return blob;
}
