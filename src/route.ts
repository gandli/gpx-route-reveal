// Pick start/end on the map → BRouter (OSM, key-free) walking route → Track.
// Feeds into the exact same loadTrack pipeline as a dropped .gpx file.
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { Track, TrackPoint } from "./gpx";

const BROUTER = "https://brouter.de/brouter";

type LngLat = [number, number];

// BRouter walking route between two points → Track (also used by presets)
export async function fetchBrouterRoute(a: LngLat, b: LngLat, name: string): Promise<Track> {
  const url =
    `${BROUTER}?lonlats=${a[0]},${a[1]}|${b[0]},${b[1]}` +
    `&profile=shortest&alternativeidx=0&format=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`BRouter HTTP ${r.status}`);
  const data = await r.json();
  // coords are [lon, lat, ele(m)] — ele present in this profile
  const coords: [number, number, number][] = data.features?.[0]?.geometry?.coordinates ?? [];
  if (coords.length < 2) throw new Error("no route found between the two points");
  const km = parseFloat(data.features[0].properties["track-length"]) / 1000 || 0;
  const points: TrackPoint[] = coords.map((c) => ({
    lon: c[0],
    lat: c[1],
    ele: Number.isFinite(c[2]) ? c[2] : null,
  }));
  const eles = points.map((p) => p.ele).filter((e): e is number => e !== null);
  return {
    name,
    points,
    distanceKm: km,
    minEle: eles.length ? Math.min(...eles) : null,
    maxEle: eles.length ? Math.max(...eles) : null,
  };
}

export class RoutePicker {
  private pts: LngLat[] = [];
  private picking = false;
  private onClick: ((e: { lngLat: { lng: number; lat: number } }) => void) | null = null;

  constructor(
    private map: MapLibreMap,
    private onStatus: (msg: string) => void,
    private onTrack: (t: Track) => void,
  ) {}

  get active() {
    return this.picking;
  }

  begin() {
    this.reset();
    this.picking = true;
    this.map.getCanvas().style.cursor = "crosshair";
    this.onStatus("Click the start point on the map");
    this.onClick = (e) => this.pick(e.lngLat.lng, e.lngLat.lat);
    this.map.on("click", this.onClick);
  }

  // Stop picking and clear markers/labels (also used to cancel mid-pick).
  reset() {
    if (this.onClick) this.map.off("click", this.onClick);
    this.onClick = null;
    this.picking = false;
    this.map.getCanvas().style.cursor = "";
    this.pts = [];
    for (const id of ["pick-a", "pick-b"]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }

  private pick(lng: number, lat: number) {
    this.pts.push([lng, lat]);
    this.marker(this.pts.length === 1 ? "pick-a" : "pick-b", lng, lat);
    if (this.pts.length === 1) {
      this.onStatus("Click the end point");
      return;
    }
    // both points in — detach click handler while routing
    if (this.onClick) this.map.off("click", this.onClick);
    this.onClick = null;
    this.map.getCanvas().style.cursor = "wait";
    this.onStatus("Routing…");
    this.fetchRoute(this.pts[0], this.pts[1]);
  }

  private marker(id: string, lng: number, lat: number) {
    const pt: GeoJSON.Feature<GeoJSON.Point> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [lng, lat] },
    };
    if (!this.map.getSource(id)) {
      this.map.addSource(id, { type: "geojson", data: pt });
      this.map.addLayer({
        id,
        type: "circle",
        source: id,
        paint: { "circle-color": id === "pick-a" ? "#22c55e" : "#ef4444", "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
    } else {
      (this.map.getSource(id) as GeoJSONSource).setData(pt);
    }
  }

  private async fetchRoute(a: LngLat, b: LngLat) {
    try {
      const track = await fetchBrouterRoute(a, b, "Picked route");
      this.picking = false;
      this.map.getCanvas().style.cursor = "";
      this.onStatus(`Route: ${track.distanceKm.toFixed(1)} km, ${track.points.length} pts — click Pick again to redraw`);
      this.onTrack(track);
    } catch (e) {
      this.onStatus(`Route failed: ${(e as Error).message} — click Pick to retry`);
      this.reset();
    }
  }
}
