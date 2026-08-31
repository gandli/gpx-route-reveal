import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { parseGpx, type Track } from "./gpx";
import { RouteReveal } from "./animate";
import { recordWebm } from "./recorder";
import { RoutePicker, fetchBrouterRoute } from "./route";

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
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["get", "render_height"],
            2, "hsl(35, 12%, 82%)",   // low buildings — pale
            8, "hsl(35, 14%, 74%)",   // 2-3 floors
            15, "hsl(30, 18%, 66%)",  // mid-rise
            25, "hsl(25, 22%, 58%)",  // taller — warmer/darker
            40, "hsl(20, 26%, 50%)",  // high-rise
          ],
          "fill-extrusion-height": ["get", "render_height"],
          "fill-extrusion-opacity": 0.9,
        },
      },
    ],
    // real 3D terrain mesh — without this the map is flat; pitch is only an angle
    terrain: { source: "terrain", exaggeration: 1.6 },
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
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const loopBtn = document.getElementById("loop") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const speedVal = document.getElementById("speedval")!;
const progress = document.getElementById("progress") as HTMLInputElement;
const pickBtn = document.getElementById("pick") as HTMLButtonElement;
const presetSel = document.getElementById("preset") as HTMLSelectElement;

// preset routes: waypoints → BRouter walking route (A→B, or a multi-point trail)
const PRESETS: Record<string, { waypoints: [number, number][]; name: string }> = {
  "yongquan-baiyun": {
    waypoints: [[119.3905827, 26.058507], [119.3761614, 26.0760735]],
    name: "Yongquan → Baiyun",
  },
  "fudao-jinniushan": {
    waypoints: [[119.2487938, 26.0848005], [119.2596272, 26.0880239]],
    name: "Fudao → Jinniushan",
  },
  "fudao-full": {
    waypoints: [
      [119.2487938, 26.0848005],  // Fudao trailhead, Hongshan
      [119.256591, 26.081026],    // Jinniushan park
      [119.2596272, 26.0880239],  // back up the skywalk
      [119.2615119, 26.090036],   // 福道 footway
      [119.2663221, 26.0940545],  // Meifeng Mountain park
      [119.2752913, 26.0964445],  // 福道 footway
      [119.2770275, 26.0997199],  // Zuohai park west gate
    ],
    name: "Fudao Full Trail",
  },
  "sanfang-yantai": {
    waypoints: [[119.2919836, 26.0850946], [119.3108953, 26.0481449]],
    name: "Sanfang → Yantai",
  },
  "wushan-yushan": {
    waypoints: [[119.2896128, 26.0780444], [119.3033916, 26.0813406]],
    name: "Wushan → Yushan",
  },
  "shangxiahang-yantai": {
    waypoints: [[119.3030957, 26.0559454], [119.3108953, 26.0481449]],
    name: "Shangxiahang → Yantai",
  },
};

let reveal: RouteReveal | null = null;

function setDrop(msg: string) {
  drop.textContent = msg;
}

// shared path: loadTrack(file) and the map picker both land here
function loadTrackFromData(track: Track) {
  setDrop(`${track.name} — ${track.points.length} pts, ${track.distanceKm.toFixed(1)} km`);
  meta.hidden = false;
  meta.textContent =
    `elev ${track.minEle ?? "?"}–${track.maxEle ?? "?"} m · ${track.points.length} pts · ` +
    `${track.distanceKm.toFixed(1)} km`;
  controls.hidden = false;
  // sources must be added after the style has loaded — the map canvas
  // appears before 'load', so defer if needed.
  const build = () => {
    // destroy inside build: two queued builds (auto-load + drop race) can't
    // both addSource the same IDs — delay destroy until we actually rebuild.
    if (reveal) reveal.destroy();
    reveal = new RouteReveal(map, track);
    reveal.onProgress = (t) => {
      progress.value = String(Math.round(t * 1000));
    };
    progress.value = "0";
    syncPlayUI();
    // auto-play so the camera follows the route immediately (demo UX)
    reveal.setPlaying(true);
    syncPlayUI();
  };
  // isStyleLoaded() stays false while tiles stream and 'style.load' never
  // re-fires on an already-parsed style. Gate on the style's base layers
  // existing (public API — same timing as style.load) and poll until then.
  const styleReady = () => !!map.getLayer("satellite");
  if (styleReady()) build();
  else {
    const timer = window.setInterval(() => {
      if (!styleReady()) return;
      window.clearInterval(timer);
      build();
    }, 200);
    window.setTimeout(() => window.clearInterval(timer), 30000); // no leak
  }
}

function loadTrack(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const track = parseGpx(String(reader.result));
      loadTrackFromData(track);
    } catch (e) {
      setDrop(`Error: ${(e as Error).message}`);
    }
  };
  reader.readAsText(file);
}

// pick start/end on the map → BRouter walking route → same pipeline as GPX drop
const picker = new RoutePicker(map, setDrop, loadTrackFromData);
pickBtn.addEventListener("click", () => {
  if (picker.active) picker.reset();
  else picker.begin();
});

presetSel.addEventListener("change", async () => {
  const key = presetSel.value;
  presetSel.selectedIndex = 0; // re-selectable next time
  if (!key) return;
  if (key === "moxi") {
    try {
      const t = await fetch("demo.gpx").then((r) => r.text());
      loadTrackFromData(parseGpx(t));
    } catch {
      setDrop("Preset load failed");
    }
    return;
  }
  const p = PRESETS[key];
  setDrop("Routing preset…");
  try {
    loadTrackFromData(await fetchBrouterRoute(p.waypoints, p.name));
  } catch (e) {
    setDrop(`Preset failed: ${(e as Error).message}`);
  }
});

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("dragover", (e) => e.preventDefault());
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && f.name.toLowerCase().endsWith(".gpx")) loadTrack(f);
  else setDrop("Only .gpx files");
});
fileInput.addEventListener("change", () => fileInput.files?.[0] && loadTrack(fileInput.files[0]));

// play/pause are separate buttons; state lives in reveal, UI synced here
function syncPlayUI() {
  const playing = !!reveal?.state.playing;
  playBtn.disabled = playing;
  pauseBtn.disabled = !playing;
  loopBtn.setAttribute("aria-pressed", String(!!reveal?.state.loop));
}

playBtn.addEventListener("click", () => {
  if (!reveal) return;
  reveal.setPlaying(true);
  syncPlayUI();
});
pauseBtn.addEventListener("click", () => {
  if (!reveal) return;
  reveal.setPlaying(false);
  syncPlayUI();
});
loopBtn.addEventListener("click", () => {
  if (!reveal) return;
  reveal.state.loop = !reveal.state.loop;
  syncPlayUI();
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
    exportBtn.textContent = "⬇ Export";
    syncPlayUI();
  }
});

// auto-load the demo track so the map shows a route without dragging
// (mobile browsers can't drag files) — loadTrack handles style-load timing
fetch("demo.gpx")
  .then((r) => r.blob())
  .then((b) => loadTrack(new File([b], "demo.gpx", { type: "application/gpx+xml" })))
  .catch(() => setDrop("Drop a .gpx file"));
