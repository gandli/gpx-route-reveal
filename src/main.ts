import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

// Scaffold shell — satellite map only. Route-reveal features land via PR.

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
      terrain: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      { id: "terrain", type: "hillshade", source: "terrain", paint: { "hillshade-exaggeration": 0.6 } },
    ],
  },
  center: [119.305, 26.082],
  zoom: 12,
  pitch: 40,
  attributionControl: { compact: true },
  maxPitch: 85,
});
