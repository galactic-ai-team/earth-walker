import {
  Cartesian3,
  Ion,
  Math as CesiumMath,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { createTerrainProvider } from './terrain';
import { addImageryLayers, tuneTileStreaming } from './imagery';
import { PRESETS, type CameraPreset } from './presets';
import { EXTRA_PRESETS, mountSearchBox } from './search';
import { clearBuildings, loadBuildingsAround } from './buildings';
import { setupSky } from './sky';
import { attachPermalinkWriter, initPermalink } from './permalink';

// No Cesium ion anywhere: blank the default token so nothing ion-backed loads.
Ion.defaultAccessToken = '';

const viewer = new Viewer('cesiumContainer', {
  baseLayer: false, // no ion / Bing default imagery
  baseLayerPicker: false,
  geocoder: false, // default geocoder is ion-backed
  terrainProvider: createTerrainProvider(),
  animation: false,
  timeline: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
addImageryLayers(viewer); // lane 4: EOX global + USGS / NYS / swisstopo regional
tuneTileStreaming(viewer);
setupSky(viewer); // lane 6 (Dee): built-in sky, fog, real-time sun lighting

function flyTo(p: CameraPreset, duration = 2.5): void {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(p.lon, p.lat, p.height),
    orientation: {
      heading: CesiumMath.toRadians(p.heading),
      pitch: CesiumMath.toRadians(p.pitch),
      roll: 0,
    },
    duration,
  });
}

// Lane 3 hookup: whenever the camera settles near the ground (preset, search
// teleport, walking), load OSM buildings around it. Overpass is a shared public
// API, so skip high-altitude views and only reload after moving ~150 m.
const BUILDINGS_MAX_HEIGHT_M = 2000;
const BUILDINGS_RELOAD_M = 150;
let lastBuildingsCenter: Cartesian3 | null = null;
function maybeLoadBuildings(): void {
  const c = viewer.camera.positionCartographic;
  const ground = viewer.scene.globe.getHeight(c) ?? 0;
  if (c.height - ground > BUILDINGS_MAX_HEIGHT_M) {
    if (lastBuildingsCenter) clearBuildings();
    lastBuildingsCenter = null;
    return;
  }
  const here = Cartesian3.fromRadians(c.longitude, c.latitude, 0);
  if (lastBuildingsCenter && Cartesian3.distance(here, lastBuildingsCenter) < BUILDINGS_RELOAD_M) return;
  lastBuildingsCenter = here;
  loadBuildingsAround(
    viewer,
    CesiumMath.toDegrees(c.longitude),
    CesiumMath.toDegrees(c.latitude),
  ).catch((err: unknown) => {
    lastBuildingsCenter = null;
    console.warn('OSM buildings unavailable:', err);
  });
}
viewer.camera.moveEnd.addEventListener(maybeLoadBuildings);
// moveEnd only fires once the camera stops, and a walker moves every frame,
// so also check twice a second (cheap: no request unless we've moved 150 m).
let lastBuildingsCheck = 0;
viewer.scene.postRender.addEventListener(() => {
  const now = performance.now();
  if (now - lastBuildingsCheck < 500) return;
  lastBuildingsCheck = now;
  maybeLoadBuildings();
});

const panel = document.getElementById('presets')!;
for (const p of [...PRESETS, ...EXTRA_PRESETS]) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.preset = p.id;
  b.addEventListener('click', () => flyTo(p));
  panel.appendChild(b);
}

mountSearchBox(viewer); // lane 5 (Nova): place search + teleport
// Lane 5 (Nova): shareable locations — a #lat,lon,height,heading hash
// restores that standing spot on load, and the hash stays updated as the
// camera settles, so any view can be bookmarked or shared.
void initPermalink(viewer);
attachPermalinkWriter(viewer);
import { createWalkController } from './walk';
import { isBlocked } from './buildings'; // GPT-6's building collision export

// Instantiate walk controller with GPT-6's isBlocked obstacle hook
const walker = createWalkController(viewer, { isBlocked });
let isWalking = false;

// Create walk toggle button positioned safely at bottom-left
const walkBtn = document.createElement('button');
walkBtn.textContent = '🚶 Start Walking';
walkBtn.style.cssText = 'position: absolute; bottom: 20px; left: 20px; z-index: 1000; padding: 10px 16px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-family: sans-serif;';
document.body.appendChild(walkBtn);

walkBtn.addEventListener('click', () => {
  if (!isWalking) {
    const cartographic = viewer.camera.positionCartographic;
    const startLon = CesiumMath.toDegrees(cartographic.longitude);
    const startLat = CesiumMath.toDegrees(cartographic.latitude);

    walker.enable(startLon, startLat);
    walkBtn.textContent = '🛑 Stop Walking'; // Esc only frees the mouse; click the view to look again
    isWalking = true;
  } else {
    walker.disable();
    walkBtn.textContent = '🚶 Start Walking';
    isWalking = false;
  }
});


// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
