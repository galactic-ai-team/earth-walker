import {
  Cartesian3,
  Credit,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { createTerrainProvider } from './terrain';
import { PRESETS, type CameraPreset } from './presets';

// No Cesium ion anywhere: blank the default token so nothing ion-backed loads.
Ion.defaultAccessToken = '';

// Lane 4 (imagery/tile streaming) owns this layer from here on.
const eox = new UrlTemplateImageryProvider({
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  maximumLevel: 15,
  credit: new Credit('Sentinel-2 cloudless by EOX IT Services GmbH (CC BY-NC-SA 4.0)', true),
});

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
viewer.imageryLayers.add(new ImageryLayer(eox));

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

// Expose for debugging / e2e checks.
(window as unknown as { viewer: Viewer }).viewer = viewer;
