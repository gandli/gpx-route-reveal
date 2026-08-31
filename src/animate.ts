import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { Track, TrackPoint } from "./gpx";

// Camera: interpolate along the track. pitch/zoom ramp at the ends for the
// classic "pull-in, follow, pull-out" reveal.
export interface RevealState {
  t: number; // 0..1
  playing: boolean;
  speed: number;
  loop: boolean;
}

const CAM = {
  zoom: 14.5,
  pitch: 45,
  minZoom: 13.5,
  maxZoom: 15.5,
  fov: 45,
  // lead/bias -> camera looks ahead of the head so the route "grows" below it;
  // also the chord window for bearing (crosses hairpin segments, no per-segment shake)
  leadBias: 0.08,
  // time constants (s) for the exponential low-pass; frame-rate independent
  tauCenter: 0.3,
  tauBearing: 0.6,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Endpoint smoothing for pull-in / pull-out. raw t -> eased t.
export function easeEndpoint(raw: number): number {
  if (raw < 0.12) return 0; // wait at start
  if (raw > 0.88) return 1; // hold at finish
  return (raw - 0.12) / 0.76; // linear travel between
}

// Cumulative distance along the track, normalized to 0..1 per point index.
export function cumDist(points: TrackPoint[]): Float64Array {
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cum[i] =
      cum[i - 1] +
      haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  const total = cum[cum.length - 1] || 1;
  for (let i = 0; i < points.length; i++) cum[i] /= total;
  return cum;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

// Index + fraction between two points for a normalized distance t.
export function sampleAlong(points: TrackPoint[], cum: Float64Array, t: number): { a: number; f: number } {
  if (t <= 0) return { a: 0, f: 0 };
  if (t >= 1) return { a: points.length - 2, f: 1 };
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  return { a: lo, f: (t - cum[lo]) / span };
}

// LineString of the route up to normalized distance t.
export function routeUpTo(points: TrackPoint[], cum: Float64Array, t: number): GeoJSON.LineString {
  const { a, f } = sampleAlong(points, cum, t);
  const coords: [number, number][] = points.slice(0, a + 1).map((p) => [p.lon, p.lat]);
  if (f > 0) {
    const p = points[a];
    const n = points[a + 1];
    coords.push([lerp(p.lon, n.lon, f), lerp(p.lat, n.lat, f)]);
  }
  return { type: "LineString", coordinates: coords };
}

// Interpolated position at normalized distance t.
function interpAt(points: TrackPoint[], cum: Float64Array, t: number): [number, number] {
  const { a, f } = sampleAlong(points, cum, t);
  const p = points[a];
  const n = points[a + 1];
  return [lerp(p.lon, n.lon, f), lerp(p.lat, n.lat, f)];
}

// Camera state at normalized distance t. Returns { center, zoom, pitch, bearing }.
export function cameraAt(
  points: TrackPoint[],
  cum: Float64Array,
  t: number,
): { center: [number, number]; zoom: number; pitch: number; bearing: number } {
  const [hx, hy] = interpAt(points, cum, t);
  const [cx, cy] = interpAt(points, cum, Math.min(1, t + CAM.leadBias));
  // chord bearing over the lead window — stable across dense polylines;
  // center stays on head(t) so the upcoming segment is visible from behind,
  // not from a look-ahead point that may be on the far side of a ridge.
  const bearing = ((Math.atan2(cx - hx, cy - hy) * 180) / Math.PI + 360) % 360;

  const zoom = lerp(CAM.minZoom, CAM.maxZoom, 0.5 + 0.5 * Math.sin(Math.PI * t));
  const pitch = lerp(30, CAM.pitch, 0.5 + 0.5 * Math.sin(Math.PI * t));
  return { center: [hx, hy], zoom, pitch, bearing };
}

// ---- Animator: owns the map, canvas sync, and the reveal loop. ----
export class RouteReveal {
  map: MapLibreMap;
  track: Track;
  cum: Float64Array;
  state: RevealState = { t: 0, playing: false, speed: 1, loop: false };
  routeLayer = "route-progress";
  onProgress: ((t: number) => void) | null = null;
  private raf = 0;
  private last = 0;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private hidden: boolean = false;
  private sm: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null;

  constructor(map: MapLibreMap, track: Track) {
    this.map = map;
    this.track = track;
    this.cum = cumDist(track.points);
    map.setPitch(40);
    map.setBearing(0);
    map.setZoom(12.5);
    map.setCenter([track.points[0].lon, track.points[0].lat]);
    // fit whole track
    const ls: GeoJSON.LineString = { type: "LineString", coordinates: track.points.map((p) => [p.lon, p.lat]) };
    // first draw full route, then the reveal layer on top with a "not yet shown" style
    map.addSource("route-full", { type: "geojson", data: { type: "Feature", properties: {}, geometry: ls } });
    map.addLayer({
      id: "route-full",
      type: "line",
      source: "route-full",
      paint: { "line-color": "#f87171", "line-width": 3 },
      layout: { "line-join": "round", "line-cap": "round" },
    });
    map.addSource("route-progress", {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: routeUpTo(this.track.points, this.cum, 0) },
    });
    map.addLayer({
      id: this.routeLayer,
      type: "line",
      source: "route-progress",
      paint: {
        "line-color": "#22c55e",
        "line-width": 5,
        "line-opacity": 0.95,
        "line-blur": 1,
      },
      layout: { "line-join": "round", "line-cap": "round" },
    });
    // head marker — same layer-ownership rule as above: everything is added
    // here, after the constructor's caller has confirmed the style is loaded.
    map.addSource("head", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } } });
    map.addLayer({
      id: "head",
      type: "circle",
      source: "head",
      paint: { "circle-color": "#22c55e", "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
  }

  setPlaying(p: boolean) {
    this.state.playing = p;
    if (p) {
      // replay: pressing Play at the end restarts from the beginning
      if (this.state.t >= 1) {
        this.state.t = 0;
        this.sm = null; // re-seed camera at the start instead of gliding back
      }
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } else {
      cancelAnimationFrame(this.raf);
    }
  }

  setT(t: number) {
    this.state.t = Math.max(0, Math.min(1, t));
    this.render();
  }

  private tick = (now: number) => {
    if (!this.state.playing) return;
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.state.t = Math.min(1, this.state.t + (dt * this.state.speed) / 45); // ~45s per route at 1×
    if (this.state.t >= 1) {
      if (this.state.loop) {
        this.state.t = 0;
        this.sm = null; // re-seed camera at the start instead of gliding back
      } else this.setPlaying(false);
    }
    this.render(dt); // dt from rAF tick → time-constant smoothing
    if (this.state.playing) this.raf = requestAnimationFrame(this.tick);
  };

  render(dt?: number) {
    const t = this.state.t;
    const target = cameraAt(this.track.points, this.cum, easeEndpoint(t));
    // low-pass smoothing: glide toward the target instead of snapping.
    // dt=undefined (scrub) → snap exactly; else exponential time-constant filter.
    if (!this.sm || dt === undefined) this.sm = { ...target };
    else {
      const s = this.sm;
      const a = 1 - Math.exp(-dt / CAM.tauCenter);
      s.center[0] = lerp(s.center[0], target.center[0], a);
      s.center[1] = lerp(s.center[1], target.center[1], a);
      s.zoom = lerp(s.zoom, target.zoom, a);
      s.pitch = lerp(s.pitch, target.pitch, a);
      // bearing: slower filter + shortest way around the wrap
      const ab = 1 - Math.exp(-dt / CAM.tauBearing);
      let db = ((target.bearing - s.bearing + 540) % 360) - 180;
      s.bearing = (s.bearing + db * ab + 360) % 360;
    }
    // don't fight the user while dragging/paused
    if (!this.map.isMoving()) {
      this.map.jumpTo({ center: this.sm.center, zoom: this.sm.zoom, pitch: this.sm.pitch, bearing: this.sm.bearing });
    }
    (this.map.getSource("route-progress") as GeoJSONSource).setData({
      type: "Feature",
      properties: {},
      geometry: routeUpTo(this.track.points, this.cum, t),
    });
    // head marker: small dot at the current head point
    // head marker sits exactly at the growth tip (camera keeps leadBias, dot doesn't)
    const { a, f } = sampleAlong(this.track.points, this.cum, t);
    const [hx, hy] = [
      lerp(this.track.points[a].lon, this.track.points[a + 1].lon, f),
      lerp(this.track.points[a].lat, this.track.points[a + 1].lat, f),
    ];
    (this.map.getSource("head") as GeoJSONSource).setData({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [hx, hy] },
    });
    if (this.onProgress) this.onProgress(t);
    this.paintCanvas();
  }

  // Overlay canvas on top of the map, locked to the map container. Used as the
  // capture source when recording; normally transparent.
  ensureCanvas() {
    if (this.canvas) return;
    const el = this.map.getContainer();
    const r = el.getBoundingClientRect();
    const c = document.createElement("canvas");
    c.width = r.width;
    c.height = r.height;
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    el.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
  }

  private paintCanvas() {
    if (!this.ctx || this.hidden) return;
    this.ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
    const t = this.state.t;
    if (t <= 0 || t >= 1) return;
    // subtle dark vignette + heading arc
    const w = this.canvas!.width;
    const h = this.canvas!.height;
    const g = this.ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(0,0,0,0.25)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, w, h * 0.3);
  }

  // Set to true during recording to keep the frame clean (map renders below).
  setCanvasHidden(v: boolean) {
    this.hidden = v;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.setPlaying(false);
    // remove layers/sources so a new RouteReveal can be built on the same map
    // (pick-route creates one per route) without duplicate-ID crashes.
    for (const id of ["route-full", "route-progress", "head"]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}


