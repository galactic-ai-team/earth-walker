// src/imagery.ts — earth-walker imagery + tile streaming (lane 4, owner: Lumi).
//
// Free, keyless, CORS-enabled imagery only (no Cesium ion, no API keys).
// Layers are stacked bottom to top; each regional layer is clipped to a
// rectangle so it is only requested where it has data, and the globe falls
// back to the layer underneath everywhere else:
//
//   1. EOX Sentinel-2 cloudless 2020 — global base, ~10 m/px (z15 is plenty).
//      CC BY-NC-SA 4.0 (non-commercial; fine for this project).
//   2. USGS National Map orthoimagery — USA, public domain, cached tiles up to
//      z16 (~1.8 m/px at NYC). Beyond z16 Cesium upsamples.
//   3. NYS ITS orthoimagery (wms/Latest) — New York City only, ~30 cm/px
//      (12-inch NYSDOP, 2022-2025), free public ArcGIS service. It is a dynamic
//      export (not a tile cache), so it is restricted to NYC and only switched
//      on close to the ground. "jpgpng" returns JPEG for full tiles and a
//      transparent PNG where the tile leaves New York State (e.g. New Jersey).
//   4. swisstopo SWISSIMAGE — Switzerland, 10-25 cm/px, free FSDI open data,
//      cached WMTS up to z20 ("© swisstopo" credit required).
//
// Everything here except addImageryLayers()/tuneTileStreaming() is plain data
// so imagery.test.ts can check it without a browser or network.

import {
  Credit,
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  type Viewer,
} from 'cesium';

/** Bounding box in degrees. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ImagerySource {
  id: 'eox' | 'usgs' | 'nys' | 'swisstopo';
  /** Cesium UrlTemplateImageryProvider template. */
  url: string;
  /** Highest zoom level the server actually has tiles for (checked with curl). */
  maximumLevel: number;
  /** Don't draw this layer on globe tiles coarser than this level. */
  minimumTerrainLevel?: number;
  /** Where the layer is requested; undefined = whole globe. */
  bbox?: BBox;
  credit: string;
  license: string;
}

export const EOX: ImagerySource = {
  id: 'eox',
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  maximumLevel: 15,
  credit:
    '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless - https://s2maps.eu</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0',
  license: 'CC BY-NC-SA 4.0',
};

/** Lower 48 states. (Alaska/Hawaii are served too but not clipped in here yet.) */
export const CONUS_BBOX: BBox = { west: -125.0, south: 24.4, east: -66.9, north: 49.4 };

export const USGS: ImagerySource = {
  id: 'usgs',
  url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
  maximumLevel: 16,
  bbox: CONUS_BBOX,
  credit:
    '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>: Orthoimagery (USDA NAIP), public domain',
  license: 'Public domain (US Government work)',
};

/** The five boroughs of New York City (plus a little water/Jersey shore, which comes back transparent). */
export const NYC_BBOX: BBox = { west: -74.26, south: 40.49, east: -73.69, north: 40.92 };

export const NYS: ImagerySource = {
  id: 'nys',
  url:
    'https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export' +
    '?bbox={westProjected},{southProjected},{eastProjected},{northProjected}' +
    '&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&transparent=true&f=image',
  maximumLevel: 19,
  minimumTerrainLevel: 14,
  bbox: NYC_BBOX,
  credit:
    '<a href="https://gis.ny.gov/orthoimagery" target="_blank" rel="noopener">NYS ITS Geospatial Services</a> orthoimagery',
  license: 'NYS public data, free of charge (as-is, no warranty)',
};

/** Switzerland's bounding box; SWISSIMAGE also covers a strip of the neighbours. */
export const SWITZERLAND_BBOX: BBox = { west: 5.9, south: 45.8, east: 10.5, north: 47.85 };

export const SWISSTOPO: ImagerySource = {
  id: 'swisstopo',
  url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
  maximumLevel: 20,
  bbox: SWITZERLAND_BBOX,
  credit: '<a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">© swisstopo</a> SWISSIMAGE',
  license: 'swisstopo open data (OGD), free, "© swisstopo" attribution',
};

/** Bottom to top. */
export const IMAGERY_SOURCES: readonly ImagerySource[] = [EOX, USGS, NYS, SWISSTOPO];

export function bboxContains(b: BBox | undefined, lon: number, lat: number): boolean {
  if (!b) return true;
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

/** Ids of the sources that cover a point, bottom to top (the last one is what you see up close). */
export function sourcesCovering(lon: number, lat: number): ImagerySource['id'][] {
  return IMAGERY_SOURCES.filter((s) => bboxContains(s.bbox, lon, lat)).map((s) => s.id);
}

export function createProvider(s: ImagerySource): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    url: s.url,
    maximumLevel: s.maximumLevel,
    rectangle: s.bbox ? Rectangle.fromDegrees(s.bbox.west, s.bbox.south, s.bbox.east, s.bbox.north) : undefined,
    credit: new Credit(s.credit, true),
  });
}

/** Adds all imagery layers to the viewer (call once, with baseLayer: false). */
export function addImageryLayers(viewer: Viewer): ImageryLayer[] {
  return IMAGERY_SOURCES.map((s) => {
    const layer = new ImageryLayer(createProvider(s), {
      minimumTerrainLevel: s.minimumTerrainLevel,
    });
    viewer.imageryLayers.add(layer);
    return layer;
  });
}

/** Cheap streaming tweaks for walking around at street level. */
export function tuneTileStreaming(viewer: Viewer): void {
  const globe = viewer.scene.globe;
  globe.maximumScreenSpaceError = 2; // Cesium default; keep sharp without flooding requests
  globe.tileCacheSize = 400; // default 100: keep more of the neighbourhood when turning around
  globe.preloadAncestors = true; // coarse parents first so there are no holes while streaming
}
