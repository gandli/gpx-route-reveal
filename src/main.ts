import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { parseGpx } from "./gpx";
import { RouteReveal } from "./animate";
import { recordWebm } from "./recorder";

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "© Esri — Source: Esri, Maxar, Earthstar Geographics",
        maxzoom: 19,
      },
      // OSM vector tiles (OpenMapTiles schema) — building footprints + heights
      // for 3D extrusion. Versioned planet path from tiles.openfreemap.org/planet.
      buildings: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      },
      terrain: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      },
      terrainShade: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      { id: "terrain", type: "hillshade", source: "terrainShade", paint: { "hillshade-exaggeration": 1 } },
      // 3D buildings on top of the satellite imagery — fill-extrusion with OSM heights
      {
        id: "building-3d",
        type: "fill-extrusion",
        source: "buildings",
        "source-layer": "building",
        minzoom: 14,
        paint: {
          "fill-extrusion-base": ["get", "render_min_height"],
          "fill-extrusion-color": "hsl(35, 8%, 85%)",
          "fill-extrusion-height": ["get", "render_height"],
          "fill-extrusion-opacity": 0.85,
        },
      },
    ],
    // real 3D terrain mesh — without this the map is flat; pitch is only an angle
    terrain: { source: "terrain", exaggeration: 1.5 },
  },
  center: [119.305, 26.082],
  zoom: 12,
  pitch: 40,
  attributionControl: { compact: true },
  maxPitch: 85,
});

// debug hooks for headless E2E
const _w = window as unknown as { __map: typeof map; __reveal: typeof reveal };
_w.__map = map;
Object.defineProperty(_w, "__reveal", { get: () => reveal });

const drop = document.getElementById("drop")!;
const fileInput = document.getElementById("file") as HTMLInputElement;
const meta = document.getElementById("meta")!;
const controls = document.getElementById("controls")!;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const speedVal = document.getElementById("speedval")!;
const progress = document.getElementById("progress") as HTMLInputElement;

let reveal: RouteReveal | null = null;

function setDrop(msg: string) {
  drop.textContent = msg;
}

function loadTrack(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const track = parseGpx(String(reader.result));
      setDrop(`${track.name} — ${track.points.length} pts, ${track.distanceKm.toFixed(1)} km`);
      meta.hidden = false;
      meta.textContent =
        `elev ${track.minEle ?? "?"}–${track.maxEle ?? "?"} m · ${track.points.length} pts · ` +
        `${track.distanceKm.toFixed(1)} km`;
      controls.hidden = false;
      if (reveal) reveal.destroy();
      // sources must be added after the style has loaded — the map canvas
      // appears before 'load', so defer if needed.
      // Use style.load (fires after JSON parse, before tiles) not map.loaded
      // (which waits for all visible tiles — hangs in headless).
      const build = () => {
        reveal = new RouteReveal(map, track);
        reveal.onProgress = (t) => {
          progress.value = String(Math.round(t * 1000));
        };
        playBtn.textContent = "Play";
        progress.value = "0";
        // auto-play so the camera follows the route immediately (demo UX)
        reveal.setPlaying(true);
        playBtn.textContent = "Pause";
      };
      if (map.isStyleLoaded()) build();
      else map.once("style.load", build);
    } catch (e) {
      setDrop(`Error: ${(e as Error).message}`);
    }
  };
  reader.readAsText(file);
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("dragover", (e) => e.preventDefault());
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && f.name.toLowerCase().endsWith(".gpx")) loadTrack(f);
  else setDrop("Only .gpx files");
});
fileInput.addEventListener("change", () => fileInput.files?.[0] && loadTrack(fileInput.files[0]));

playBtn.addEventListener("click", () => {
  if (!reveal) return;
  reveal.setPlaying(!reveal.state.playing);
  playBtn.textContent = reveal.state.playing ? "Pause" : "Play";
});
speedInput.addEventListener("input", () => {
  if (!reveal) return;
  reveal.state.speed = parseFloat(speedInput.value);
  speedVal.textContent = speedInput.value;
});
progress.addEventListener("input", () => {
  if (!reveal || reveal.state.playing) return;
  reveal.setT(parseInt(progress.value, 10) / 1000);
});

exportBtn.addEventListener("click", async () => {
  if (!reveal) return;
  exportBtn.disabled = true;
  exportBtn.textContent = "Recording…";
  setDrop("Recording… (keep this tab visible)");
  try {
    const blob = await recordWebm(map, reveal, () => {});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${reveal.track.name.replace(/[^\w-]+/g, "_") || "route"}.webm`;
    a.click();
    setDrop("Exported ✓");
  } catch (e) {
    setDrop(`Export failed: ${(e as Error).message}`);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = "Export MP4";
  }
});

// auto-load the demo track so the map shows a route without dragging
// (mobile browsers can't drag files) — loadTrack handles style-load timing
fetch("demo.gpx")
  .then((r) => r.blob())
  .then((b) => loadTrack(new File([b], "demo.gpx", { type: "application/gpx+xml" })))
  .catch(() => setDrop("Drop a .gpx file"));
