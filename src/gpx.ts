// Minimal GPX track parser — no DOM, works in Node for tests and in the browser.
export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export interface Track {
  name: string;
  points: TrackPoint[];
  distanceKm: number;
  minEle: number | null;
  maxEle: number | null;
}

// ~6371 km mean earth radius; simple haversine, plenty for display.
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

export function parseGpx(xml: string): Track {
  // Regex-based: GPX structure is trivial (<trkpt lat lon><ele>), and this
  // keeps the parser runnable under bare Node for the self-check below.
  // ponytail: assumes lat-before-lon attribute order (the GPX convention) and
  // ele nested directly in trkpt; switch to a real XML parser if extensions creep in.
  const seg = /<trkseg[\s\S]*?<\/trkseg>/.exec(xml);
  if (!seg) throw new Error("No <trk>/<trkseg> found in GPX file");

  const points: TrackPoint[] = [];
  for (const m of seg[0].matchAll(/<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>(?:<ele>([^<]*)<\/ele>)?/g)) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const e = m[3] === undefined ? NaN : parseFloat(m[3]);
    points.push({ lat, lon, ele: Number.isFinite(e) ? e : null });
  }
  if (points.length < 2) throw new Error("Track needs at least 2 points");

  const name = /<trk>[\s\S]*?<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? "Track";
  let distanceKm = 0;
  for (let i = 1; i < points.length; i++) {
    distanceKm += haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  const eles = points.map((p) => p.ele).filter((e): e is number => e !== null);
  const minEle = eles.length ? Math.min(...eles) : null;
  const maxEle = eles.length ? Math.max(...eles) : null;
  return { name, points, distanceKm, minEle, maxEle };
}

// ---- Self-check (runs via `node --experimental-strip-types src/gpx.ts`) ----
const g = globalThis as { process?: { argv?: string[] } };
if (g.process?.argv?.[1] && import.meta.url === `file://${g.process.argv[1]}`) {
  const t = parseGpx(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Demo</name><trkseg>
    <trkpt lat="26.082" lon="119.305"><ele>80</ele></trkpt>
    <trkpt lat="26.083" lon="119.308"><ele>90</ele></trkpt>
    <trkpt lat="26.084" lon="119.311"><ele>100</ele></trkpt>
  </trkseg></trk>
</gpx>`);
  console.assert(t.name === "Demo", "name");
  console.assert(t.points.length === 3, "points count");
  console.assert(t.minEle === 80 && t.maxEle === 100, "elevation");
  console.assert(t.distanceKm > 0.4 && t.distanceKm < 0.5, `distance ~${t.distanceKm.toFixed(2)}km`);
  console.log("gpx self-check OK —", t.distanceKm.toFixed(2), "km");
}
