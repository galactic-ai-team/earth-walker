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
import { clearBuildings, loadBuildingsAround } from './buildings';

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
  refreshBuildings(p.lon, p.lat, p.height);
}

// Lane 3 hookup: load OSM buildings around street-level destinations only
// (Overpass is a shared public API; skip it for high-altitude views).
const BUILDINGS_MAX_HEIGHT_M = 2000;
function refreshBuildings(lon: number, lat: number, height: number): void {
  if (height > BUILDINGS_MAX_HEIGHT_M) {
    clearBuildings();
    return;
  }
  loadBuildingsAround(viewer, lon, lat).catch((err: unknown) => {
    console.warn('OSM buildings unavailable:', err);
  });
}

const panel = document.getElementById('presets')!;
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.preset = p.id;
  b.addEventListener('click', () => flyTo(p));
  panel.appendChild(b);
}

// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
