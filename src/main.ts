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
import { clearStreetObjects, isStreetObstacle, loadStreetObjectsAround } from './streetObjects';
import { setupSky } from './sky';
import { clearRoads, loadRoadsAround } from './roads';
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
    if (lastBuildingsCenter) {
      clearBuildings();
      clearStreetObjects();
    }
    lastBuildingsCenter = null;
    return;
  }
  const here = Cartesian3.fromRadians(c.longitude, c.latitude, 0);
  if (lastBuildingsCenter && Cartesian3.distance(here, lastBuildingsCenter) < BUILDINGS_RELOAD_M) return;
  lastBuildingsCenter = here;
  const lon = CesiumMath.toDegrees(c.longitude);
  const lat = CesiumMath.toDegrees(c.latitude);
  loadBuildingsAround(viewer, lon, lat)
    .catch((err: unknown) => {
      lastBuildingsCenter = null;
      console.warn('OSM buildings unavailable:', err);
    })
    // Trees + street furniture (Claude): after the buildings, so the public
    // Overpass mirrors see one query at a time and scattered park trees can
    // skip building footprints.
    .then(() =>
      loadStreetObjectsAround(viewer, lon, lat, { exclude: (lo, la) => isBlocked(lo, la, 1) }),
    )
    .catch((err: unknown) => console.warn('OSM trees/street furniture unavailable:', err));
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

// Lane 5 (Nova): roads + sidewalks settle-load alongside buildings.
const ROADS_MAX_HEIGHT_M = 2000;
viewer.camera.moveEnd.addEventListener(() => {
  const c = viewer.camera.positionCartographic;
  const ground = viewer.scene.globe.getHeight(c) ?? 0;
  if (c.height - ground > ROADS_MAX_HEIGHT_M) {
    clearRoads();
    return;
  }
  loadRoadsAround(
    viewer,
    CesiumMath.toDegrees(c.longitude),
    CesiumMath.toDegrees(c.latitude),
  ).catch((err: unknown) => console.warn('OSM roads unavailable:', err));
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
import { createAvatar } from './avatar';
import { createChaseCam, nextViewMode, type ViewMode } from './chaseCam';

// Lumi: third-person avatar + chase camera. The walker stays the only owner of
// the player position; avatar and camera just read its state each frame.
const avatar = createAvatar(viewer);
let viewMode: ViewMode = 'third';
let chase: ReturnType<typeof createChaseCam> | null = null;

// Instantiate walk controller with GPT-6's isBlocked obstacle hook
const walker = createWalkController(viewer, {
  isBlocked: (lon, lat) => isBlocked(lon, lat) || isStreetObstacle(lon, lat),
  placeCamera: (state, dt) => {
    avatar.update(state, dt);
    return viewMode === 'third' && chase !== null && chase.place(state, dt);
  },
});
chase = createChaseCam(viewer, { groundAt: walker.groundAt, isBlocked });
let isWalking = false;
let lastStop: { lon: number; lat: number; camLon: number; camLat: number } | null = null;
function groundDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6371000;
}

// View toggle (V) + a small button and controls hint, shown while walking.
const viewBtn = document.createElement('button');
viewBtn.style.cssText = 'position: absolute; bottom: 20px; left: 170px; z-index: 1000; padding: 10px 14px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-family: sans-serif; display: none;';
document.body.appendChild(viewBtn);
const hint = document.createElement('div');
hint.textContent = 'WASD move · Shift run · mouse look (click view) · V 1st/3rd person · Esc free mouse';
hint.style.cssText = 'position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 1000; padding: 6px 10px; background: rgba(0,0,0,0.55); color: #eee; border-radius: 4px; font: 12px sans-serif; pointer-events: none; display: none;';
document.body.appendChild(hint);

function applyViewMode(): void {
  viewBtn.textContent = viewMode === 'third' ? '👁 First person (V)' : '🧍 Third person (V)';
  avatar.setVisible(isWalking && viewMode === 'third');
  chase?.reset();
}
function toggleView(): void {
  viewMode = nextViewMode(viewMode);
  applyViewMode();
}
viewBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleView();
  viewBtn.blur();
});
window.addEventListener('keydown', (e) => {
  if (!isWalking || e.code !== 'KeyV' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t?.isContentEditable || (typeof t?.tagName === 'string' && /^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName))) return;
  toggleView();
});

// Create walk toggle button positioned safely at bottom-left
const walkBtn = document.createElement('button');
walkBtn.textContent = '🚶 Start Walking';
walkBtn.style.cssText = 'position: absolute; bottom: 20px; left: 20px; z-index: 1000; padding: 10px 16px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-family: sans-serif;';
document.body.appendChild(walkBtn);

walkBtn.addEventListener('click', () => {
  if (!isWalking) {
    const cartographic = viewer.camera.positionCartographic;
    let startLon = CesiumMath.toDegrees(cartographic.longitude);
    let startLat = CesiumMath.toDegrees(cartographic.latitude);
    // Resume where the avatar stood if the camera hasn't moved since Stop
    // (in 3rd person the camera sits ~5 m behind the avatar).
    if (lastStop && groundDistanceM(lastStop.camLat, lastStop.camLon, startLat, startLon) < 25) {
      startLon = lastStop.lon;
      startLat = lastStop.lat;
    }

    viewMode = 'third'; // third-person is the walk-mode default
    walker.enable(startLon, startLat);
    walkBtn.textContent = '🛑 Stop Walking'; // Esc only frees the mouse; click the view to look again
    isWalking = true;
    viewBtn.style.display = hint.style.display = 'block';
    applyViewMode();
  } else {
    const st = walker.getState();
    const cam = viewer.camera.positionCartographic;
    lastStop = {
      lon: st.lon,
      lat: st.lat,
      camLon: CesiumMath.toDegrees(cam.longitude),
      camLat: CesiumMath.toDegrees(cam.latitude),
    };
    walker.disable();
    walkBtn.textContent = '🚶 Start Walking';
    isWalking = false;
    viewBtn.style.display = hint.style.display = 'none';
    applyViewMode();
  }
});


// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
(window as unknown as { walker: typeof walker }).walker = walker;
