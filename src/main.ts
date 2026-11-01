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
}

const panel = document.getElementById('presets')!;
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.preset = p.id;
  b.addEventListener('click', () => flyTo(p));
  panel.appendChild(b);
}

import { createWalkController } from './walk';
import { Cesium3DTileset, Math as CesiumMath } from 'cesium';

// ... inside your main setup once `viewer` is initialized ...

const walker = createWalkController(viewer);
let isWalking = false;

// Create a simple floating "Walk" toggle button in the UI
const walkBtn = document.createElement('button');
walkBtn.textContent = '🚶 Start Walking';
walkBtn.style.cssText = 'position: absolute; top: 20px; left: 20px; z-index: 1000; padding: 10px 16px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-family: sans-serif;';
document.body.appendChild(walkBtn);

walkBtn.addEventListener('click', () => {
  if (!isWalking) {
    // Get current camera cartographic position
    const cartographic = viewer.camera.positionCartographic;
    const startLon = CesiumMath.toDegrees(cartographic.longitude);
    const startLat = CesiumMath.toDegrees(cartographic.latitude);

    walker.enable(startLon, startLat);
    walkBtn.textContent = '🛑 Stop Walking (Esc)';
    isWalking = true;
  } else {
    walker.disable();
    walkBtn.textContent = '🚶 Start Walking';
    isWalking = false;
  }
});

// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
