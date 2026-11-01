# Earth Walker

AI Playground project 4: a walkable 3D recreation of the Earth. Walk down a NYC block, explore the Swiss Alps.

Stack (team vote, CesiumJS 4 vs three.js 2): **CesiumJS** (`cesium`, Apache-2.0) + Vite + TypeScript, used **without Cesium ion**.

## Run

```sh
npm install
npm run dev        # local dev server
npm run build      # production build -> dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## Free-only data rules

1. **No Cesium ion.** No ion token, no ion default assets, no Bing imagery, no ion geocoder. `Ion.defaultAccessToken` stays blank.
2. **No tokens, no sign-ups, no API keys, nothing paid.** If a source needs any of those, it is a blocker for Stephon, not something we add.
3. **Keyless, openly licensed sources only**, with attribution shown in the Cesium credit display. Candidates already probed:
   - Imagery: EOX Sentinel-2 cloudless (CC BY-NC-SA 4.0), *in use*.
   - Terrain: AWS Terrain Tiles (terrarium PNG), keyless.
   - Buildings: OpenStreetMap via Overpass / OpenFreeMap vector tiles (ODbL; credit "© OpenStreetMap contributors").
   - Search: Nominatim (keyless; max 1 req/s, debounce, identify the app).
4. Not allowed without Stephon's explicit OK: Google Photorealistic 3D Tiles (billing + key), Cesium ion (account), Esri imagery (terms unclear).
5. Every data source gets a credit in the viewer and a line in this README.

## Lanes

Each lane has one owner. Stubs are in `src/`; replace a stub, keep its exported shape.

| # | Lane | File(s) | Owner |
|---|------|---------|-------|
| 1 | Terrain/height pipeline | `src/terrain.ts` | Claude |
| 2 | Walk controller + collision | `src/walk.ts` | Gemini |
| 3 | OSM buildings | `src/buildings.ts` | GPT-6 |
| 4 | Imagery/tile streaming | `src/main.ts` (imagery layer) | Dee or Lumi (Dee picks) |
| 5 | Search/teleport/presets | `src/search.ts`, `src/presets.ts` | Nova |
| 6 | Credits/sky/tests | credits, sky, `*.test.ts` | Dee or Lumi (Dee picks) |

Live: https://earth-walker-eight.vercel.app

Scaffold by Lumi: Cesium viewer (no ion), EOX imagery, flat ellipsoid terrain, preset buttons (NYC block, Swiss Alps), vitest.

## Credits

- Sentinel-2 cloudless by EOX IT Services GmbH (CC BY-NC-SA 4.0), https://s2maps.eu (contains modified Copernicus Sentinel data)
- CesiumJS, Apache-2.0
