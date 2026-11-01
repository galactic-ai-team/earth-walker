/**
 * Earth Walker — OpenFreeMap building fallback
 * Lumi (last-resort source for GPT-6's lane 3)
 *
 * Only used by buildings.ts when every Overpass endpoint has
 * failed. Loads the OpenMapTiles `building` layer from keyless
 * OpenFreeMap z14 vector tiles covering the same area and turns
 * each outer ring into the same BuildingFootprint shape the
 * Overpass path produces, so the existing extrusion and
 * isBlocked collision code run unchanged.
 *
 * Notes on the data:
 * - z14 is the OpenMapTiles max zoom; geometry is quantised to
 *   4096 units per tile (~0.3 m at NYC) and has a clip buffer.
 *   Every ring is clipped to the tile square so pieces of a
 *   building straddling a tile edge abut instead of overlapping.
 * - Buildings with equal height are merged into one multipolygon
 *   feature, so footprint ids are synthetic (tile:feature:ring).
 * - Holes (courtyards) are ignored, matching the Overpass v1 scope.
 */

import {
  VectorTile,
  type VectorTileFeature,
} from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { Credit, type Viewer } from 'cesium';

import type { BuildingFootprint, LonLat } from './buildings';

export const OFM_TILEJSON_URL =
  'https://tiles.openfreemap.org/planet';
export const OFM_ZOOM = 14;
export const OFM_TIMEOUT_MS = 15_000;
export const OFM_ATTRIBUTION =
  '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';
const OFM_ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">© OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

/** Never request more than this many z14 tiles for one load. */
export const OFM_MAX_TILES = 9;
const DEFAULT_HEIGHT_M = 10;
const METRES_PER_DEG_LAT = 111_320;

export interface TileXYZ {
  z: number;
  x: number;
  y: number;
}

export interface OfmFetchOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Skip the TileJSON lookup (tests). Must contain {z}/{x}/{y}. */
  tileUrlTemplate?: string;
  maxBuildings?: number;
}

/* ---------------- tile math (pure) ---------------- */

export function lonLatToTile(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

/** Fractional tile coordinate -> lon/lat degrees. */
export function tilePointToLonLat(
  z: number,
  tx: number,
  ty: number,
): LonLat {
  const n = 2 ** z;
  const lon = (tx / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) /
    Math.PI;
  return [lon, lat];
}

/** Bounding box of a circle of radiusM metres around lon/lat. */
export function radiusBounds(
  lon: number,
  lat: number,
  radiusM: number,
): { west: number; south: number; east: number; north: number } {
  const dLat = radiusM / METRES_PER_DEG_LAT;
  const dLon =
    dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  return {
    west: lon - dLon,
    east: lon + dLon,
    south: Math.max(-85, lat - dLat),
    north: Math.min(85, lat + dLat),
  };
}

/**
 * All z14 tiles intersecting the radius bbox, nearest first,
 * capped at OFM_MAX_TILES (the loader's 800 m max radius needs
 * at most 4 away from the poles).
 */
export function tilesForRadius(
  lon: number,
  lat: number,
  radiusM: number,
  z = OFM_ZOOM,
): TileXYZ[] {
  const b = radiusBounds(lon, lat, radiusM);
  const nw = lonLatToTile(b.west, b.north, z);
  const se = lonLatToTile(b.east, b.south, z);
  const center = lonLatToTile(lon, lat, z);
  const tiles: TileXYZ[] = [];

  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      tiles.push({ z, x, y });
    }
  }

  tiles.sort(
    (a, c) =>
      Math.hypot(a.x - center.x, a.y - center.y) -
      Math.hypot(c.x - center.x, c.y - center.y),
  );

  return tiles.slice(0, OFM_MAX_TILES);
}

/* ---------------- geometry (pure) ---------------- */

type XY = { x: number; y: number };

/**
 * Signed area in tile space (y down) using the same convention
 * as @mapbox/vector-tile: outer rings are positive, holes negative.
 */
export function signedArea(ring: readonly XY[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].x - ring[i].x) * (ring[i].y + ring[j].y);
  }
  return sum / 2;
}

/** Sutherland–Hodgman clip of a ring to the square [0, extent]². */
export function clipRingToSquare(
  ring: readonly XY[],
  extent: number,
): XY[] {
  const edges: Array<(p: XY) => number> = [
    (p) => p.x,
    (p) => extent - p.x,
    (p) => p.y,
    (p) => extent - p.y,
  ];

  let output: XY[] = ring.slice();

  for (const inside of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const dc = inside(cur);
      const dp = inside(prev);

      if ((dc >= 0) !== (dp >= 0)) {
        const t = dp / (dp - dc);
        output.push({
          x: prev.x + t * (cur.x - prev.x),
          y: prev.y + t * (cur.y - prev.y),
        });
      }
      if (dc >= 0) output.push(cur);
    }
  }

  return output;
}

function numberProp(
  value: number | string | boolean | undefined,
): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? n
    : null;
}

/** OpenMapTiles render_height / render_min_height -> metres. */
export function ofmHeights(
  properties: Record<string, number | string | boolean>,
): { heightM: number; minHeightM: number } {
  const minHeightM =
    numberProp(properties.render_min_height) ?? 0;
  const height =
    numberProp(properties.render_height) ??
    minHeightM + DEFAULT_HEIGHT_M;
  return {
    heightM: Math.max(height, minHeightM + 2),
    minHeightM,
  };
}

function ringBounds(ring: readonly LonLat[]) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

export type OfmFeatureLike = Pick<
  VectorTileFeature,
  'type' | 'extent' | 'properties' | 'loadGeometry'
>;

/**
 * Convert one decoded MVT building feature into footprints:
 * one per outer ring, clipped to its tile, in lon/lat degrees.
 */
export function featureToFootprints(
  feature: OfmFeatureLike,
  tile: TileXYZ,
  idPrefix: string,
): BuildingFootprint[] {
  if (feature.type !== 3) return [];

  const { heightM, minHeightM } = ofmHeights(feature.properties);
  const extent = feature.extent;
  const result: BuildingFootprint[] = [];
  let ringIndex = -1;

  for (const raw of feature.loadGeometry()) {
    ringIndex++;
    // Holes have negative area; skip them (v1 scope).
    if (signedArea(raw) <= 0) continue;

    const ring: LonLat[] = [];

    for (const p of clipRingToSquare(raw, extent)) {
      const ll = tilePointToLonLat(
        tile.z,
        tile.x + p.x / extent,
        tile.y + p.y / extent,
      );
      const last = ring[ring.length - 1];
      if (!last || last[0] !== ll[0] || last[1] !== ll[1]) {
        ring.push(ll);
      }
    }

    if (
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
    ) {
      ring.pop();
    }
    if (ring.length < 3) continue;

    const bounds = ringBounds(ring);
    if (
      bounds.west === bounds.east ||
      bounds.south === bounds.north
    ) {
      continue;
    }

    let cLon = 0;
    let cLat = 0;
    for (const [lon, lat] of ring) {
      cLon += lon;
      cLat += lat;
    }

    result.push({
      id: `${idPrefix}:${ringIndex}`,
      name: 'OSM building (OpenFreeMap)',
      ring,
      heightM,
      minHeightM,
      center: [cLon / ring.length, cLat / ring.length],
      bounds,
    });
  }

  return result;
}

/** Decode the `building` layer of one MVT tile. */
export function decodeBuildingTile(
  data: Uint8Array | ArrayBuffer,
  tile: TileXYZ,
): BuildingFootprint[] {
  const bytes =
    data instanceof Uint8Array ? data : new Uint8Array(data);
  const layer = new VectorTile(new PbfReader(bytes)).layers.building;
  if (!layer) return [];

  const out: BuildingFootprint[] = [];
  for (let i = 0; i < layer.length; i++) {
    out.push(
      ...featureToFootprints(
        layer.feature(i),
        tile,
        `ofm:${tile.z}/${tile.x}/${tile.y}:${i}`,
      ),
    );
  }
  return out;
}

/** Approximate ground distance in metres (equirectangular). */
function distanceM(a: LonLat, b: LonLat): number {
  const lonScale =
    METRES_PER_DEG_LAT *
    Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(
    (a[0] - b[0]) * lonScale,
    (a[1] - b[1]) * METRES_PER_DEG_LAT,
  );
}

/**
 * Keep footprints whose bbox touches the radius bbox,
 * nearest first, capped at maxBuildings.
 */
export function selectFootprints(
  footprints: readonly BuildingFootprint[],
  lon: number,
  lat: number,
  radiusM: number,
  maxBuildings: number,
): BuildingFootprint[] {
  const area = radiusBounds(lon, lat, radiusM);
  const here: LonLat = [lon, lat];

  return footprints
    .filter(
      (f) =>
        f.bounds.east >= area.west &&
        f.bounds.west <= area.east &&
        f.bounds.north >= area.south &&
        f.bounds.south <= area.north,
    )
    .map((f) => ({ f, d: distanceM(f.center, here) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxBuildings)
    .map(({ f }) => f);
}

/* ---------------- network ---------------- */

let cachedTemplate: Promise<string> | null = null;

async function fetchWithTimeout(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException('Request cancelled', 'AbortError');
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('OpenFreeMap timed out', 'TimeoutError'),
      ),
    timeoutMs,
  );
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * The TileJSON points at a dated planet build; read it at
 * runtime so we follow OpenFreeMap's regular data updates.
 * Cached for the session (cleared on failure).
 */
export async function getOfmTileTemplate(
  fetcher: typeof fetch = fetch,
  timeoutMs = OFM_TIMEOUT_MS,
): Promise<string> {
  if (!cachedTemplate) {
    const pending = (async () => {
      const res = await fetchWithTimeout(
        OFM_TILEJSON_URL,
        fetcher,
        timeoutMs,
      );
      const json = (await res.json()) as { tiles?: unknown };
      const t = Array.isArray(json.tiles) ? json.tiles[0] : undefined;
      if (
        typeof t !== 'string' ||
        !t.includes('{z}') ||
        !t.includes('{x}') ||
        !t.includes('{y}')
      ) {
        throw new Error('OpenFreeMap TileJSON has no tile URL');
      }
      return t;
    })();
    cachedTemplate = pending;
    pending.catch(() => {
      if (cachedTemplate === pending) cachedTemplate = null;
    });
  }
  return cachedTemplate;
}

export function tileUrl(template: string, t: TileXYZ): string {
  return template
    .replace('{z}', String(t.z))
    .replace('{x}', String(t.x))
    .replace('{y}', String(t.y));
}

/**
 * Footprints around lon/lat from OpenFreeMap. Throws if no tile
 * could be loaded; tiles without buildings yield [].
 */
export async function fetchOfmBuildings(
  lon: number,
  lat: number,
  radiusM: number,
  options: OfmFetchOptions = {},
): Promise<BuildingFootprint[]> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? OFM_TIMEOUT_MS;
  const template =
    options.tileUrlTemplate ??
    (await getOfmTileTemplate(fetcher, timeoutMs));

  const tiles = tilesForRadius(lon, lat, radiusM);
  const results = await Promise.allSettled(
    tiles.map(async (t) => {
      const res = await fetchWithTimeout(
        tileUrl(template, t),
        fetcher,
        timeoutMs,
        options.signal,
      );
      return decodeBuildingTile(await res.arrayBuffer(), t);
    }),
  );

  if (options.signal?.aborted) {
    throw options.signal.reason ??
      new DOMException('Request cancelled', 'AbortError');
  }

  const all: BuildingFootprint[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(String(r.reason));
  }
  if (errors.length === results.length) {
    throw new Error(
      `OpenFreeMap: all ${results.length} tiles failed: ${errors.join('; ')}`,
    );
  }

  return selectFootprints(
    all,
    lon,
    lat,
    radiusM,
    options.maxBuildings ?? 800,
  );
}

/* ---------------- credits ---------------- */

let ofmCredit: Credit | null = null;
let creditViewer: Viewer | null = null;

/**
 * Show / hide the OpenFreeMap attribution in Cesium's on-screen
 * credit display (where the imagery and terrain credits live).
 */
export function setOfmCredit(
  viewer: Viewer | null,
  on: boolean,
): void {
  if (on && viewer) {
    if (creditViewer === viewer && ofmCredit) return;
    setOfmCredit(null, false);
    ofmCredit = new Credit(OFM_ATTRIBUTION_HTML, true);
    viewer.creditDisplay.addStaticCredit(ofmCredit);
    creditViewer = viewer;
  } else if (!on && creditViewer && ofmCredit) {
    creditViewer.creditDisplay.removeStaticCredit(ofmCredit);
    ofmCredit = null;
    creditViewer = null;
  }
}
