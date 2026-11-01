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
for (const p of [...PRESETS, ...EXTRA_PRESETS]) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.preset = p.id;
  b.addEventListener('click', () => flyTo(p));
  panel.appendChild(b);
}

mountSearchBox(viewer); // lane 5 (Nova): place search + teleport

// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
