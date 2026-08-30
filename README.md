# GPX Route Reveal

Turn a GPX track into a **3D satellite route-reveal animation** — route grows
along the terrain while the camera follows. 100% in-browser, nothing uploaded.

![stack](https://img.shields.io/badge/MapLibre%20GL-4.x-396CB2)
![ts](https://img.shields.io/badge/TypeScript-strict-3178C6)

Modern rewrite of the old [3DHikeMap](https://github.com/fredderks/3DHikeMap)
(R + Leaflet) on a plain web stack — no build-time server, no 3D engine.

## Features

- Drag-and-drop GPX → route-reveal animation
- 3D terrain from free terrarium DEM + Esri World Imagery (no API key)
- Route **grows** along the track (truncated `LineString`, no per-frame gradients)
- Camera follows the track: pitch/bearing auto-orient, pull-in + pull-out
- Play / pause / speed / scrub
- **Export WebM** via native `MediaRecorder` + `canvas.captureStream` (no WebCodecs, no muxer)

## Demo

```bash
npm install
npm run dev
# open http://localhost:5173, drop samples/demo.gpx
```

## Stack

| Piece | Choice |
|---|---|
| Build | Vite 5 + TypeScript strict |
| Map / 3D | MapLibre GL 4 (raster DEM + hillshade = 3D terrain) |
| Route reveal | truncated GeoJSON `LineString` driven by cumulative-distance sampling |
| Camera | `jumpTo` interpolation along the track (FreeCamera-style) |
| Export | MediaRecorder over canvas stream → WebM |

Deliberately no Three.js / Turf.js / WebCodecs — MapLibre covers terrain,
the route animation is a few lines of geometry, and MediaRecorder is the
native export path. `ponytail:` if you later want true MP4/H.264 output,
swap `recorder.ts` for WebCodecs `VideoEncoder` + `mp4-muxer` — the canvas
capture pipeline stays the same.

## Usage

1. Open the app
2. Drop a `.gpx` file (track segment)
3. **Play** → camera flies in, route grows, camera follows the head
4. **Export MP4** → records the animation to `.webm`

Data sources: satellite imagery © Esri World Imagery; terrain DEM ©
AWS terrarium tiles (MapTiler/OpenTopography-derived). Keep the tab visible
while exporting — `MediaRecorder` throttles background tabs.

## Development

```bash
npm run build      # typecheck + bundle
node --experimental-strip-types src/gpx.ts   # parser self-check
```

## License

MIT
