/**
 * Earth Walker — OSM buildings
 * GPT-6 / lane 3
 *
 * Keyless OSM building footprints from public Overpass instances.
 * Ordered mirror fallback, per-endpoint timeout, cancellation.
 *
 * Cesium polygons use absolute metres on Claude's terrain datum.
 * Collision uses original lon/lat footprints.
 *
 * Scope v1: closed OSM building ways. Multipolygon relations,
 * detailed roof geometry and interior courtyards are future work.
 */

import {
  Cartesian3,
  Cartographic,
  Color,
  PolygonHierarchy,
  type Entity,
  type Viewer,
} from 'cesium';

import { heightAt } from './terrain';
import { fetchOfmBuildings, setOfmCredit } from './buildingsOfm';

export const OVERPASS_URL =
  'https://overpass-api.de/api/interpreter';

export const OVERPASS_ENDPOINTS: readonly string[] = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  OVERPASS_URL,
];

export const OVERPASS_TIMEOUT_MS = 10_000;
export const DEFAULT_BUILDING_HEIGHT_M = 10;
export const METRES_PER_LEVEL = 3;

const EARTH_RADIUS_M = 6371008.8;
const MAX_RADIUS_M = 800;
const MAX_BUILDINGS = 800;
const MIN_RADIUS_M = 25;

export type LonLat = readonly [lon: number, lat: number];

export interface OsmBuildingTags {
  [key: string]: string | undefined;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  tags?: OsmBuildingTags;
  geometry?: Array<{ lon: number; lat: number }>;
}

export interface OverpassResponse {
  elements: Array<{
    type: string;
    id: number;
    tags?: OsmBuildingTags;
    geometry?: Array<{ lon: number; lat: number }>;
  }>;
}

export interface BuildingFootprint {
  id: string;
  name: string;
  ring: LonLat[];
  heightM: number;
  minHeightM: number;
  center: LonLat;
  bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}

export interface OverpassFetchOptions {
  endpoints?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

let activeFootprints: BuildingFootprint[] = [];
let activeEntities: Entity[] = [];
let activeViewer: Viewer | null = null;
let requestGeneration = 0;
let pendingRequest: AbortController | null = null;

/**
 * Fetch one Overpass query through an ordered mirror list.
 *
 * - HTTP errors, network errors, malformed responses and timeouts
 *   cause the next endpoint to be tried.
 * - A valid empty elements array is a successful result.
 * - Caller cancellation stops the entire chain immediately.
 * - No automatic concurrent retries against public servers.
 *
 * The fetcher and endpoints can be injected for offline tests.
 */
export async function fetchOverpassWithFallback(
  query: string,
  options: OverpassFetchOptions = {},
): Promise<OverpassResponse> {
  const endpoints =
    options.endpoints ?? OVERPASS_ENDPOINTS;
  const timeoutMs =
    options.timeoutMs ?? OVERPASS_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const parentSignal = options.signal;

  if (endpoints.length === 0) {
    throw new Error('Overpass: no endpoints configured');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Overpass: invalid timeout');
  }

  const errors: string[] = [];

  for (const endpoint of endpoints) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason ??
        new DOMException('Request cancelled', 'AbortError');
    }

    const controller = new AbortController();
    let timedOut = false;

    const cancel = (): void => {
      controller.abort(
        parentSignal?.reason ??
        new DOMException('Request cancelled', 'AbortError'),
      );
    };

    parentSignal?.addEventListener('abort', cancel, {
      once: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException(
          'Overpass endpoint timed out',
          'TimeoutError',
        ),
      );
    }, timeoutMs);

    try {
      const separator = endpoint.includes('?') ? '&' : '?';
      const url =
        `${endpoint}${separator}data=${encodeURIComponent(query)}`;

      const response = await fetcher(url, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: unknown = await response.json();

      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray(
          (data as Partial<OverpassResponse>).elements,
        )
      ) {
        throw new Error('Invalid Overpass JSON response');
      }

      return data as OverpassResponse;
    } catch (error) {
      // A teleport or explicit clear must never continue
      // querying other mirrors.
      if (parentSignal?.aborted) {
        throw parentSignal.reason ??
          new DOMException('Request cancelled', 'AbortError');
      }

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      errors.push(
        `${endpoint}: ${timedOut ? 'timeout' : message}`,
      );
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancel);
    }
  }

  throw new Error(
    `All ${endpoints.length} Overpass endpoints failed:\n` +
      errors.join('\n'),
  );
}

/** Parse OSM length values in metres. */
export function parseLength(
  raw: string | undefined,
): number | null {
  if (!raw) return null;

  const value = raw.trim().replace(',', '.');
  const match =
    /^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|foot|')?$/i.exec(
      value,
    );

  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;

  const unit = match[2]?.toLowerCase();

  return unit === 'ft' ||
    unit === 'feet' ||
    unit === 'foot' ||
    unit === "'"
    ? number * 0.3048
    : number;
}

function levels(raw: string | undefined): number | null {
  if (!raw) return null;

  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * OSM height is total height above local ground.
 * min_height describes the bottom of an elevated structure.
 */
export function parseBuildingHeight(
  tags: OsmBuildingTags = {},
): { heightM: number; minHeightM: number } {
  const minHeightM = Math.max(
    0,
    parseLength(tags.min_height) ??
      (levels(tags['building:min_level']) ?? 0) *
        METRES_PER_LEVEL,
  );

  const buildingLevels = levels(tags['building:levels']);

  const totalHeight =
    parseLength(tags.height) ??
    (buildingLevels !== null
      ? buildingLevels * METRES_PER_LEVEL
      : minHeightM + DEFAULT_BUILDING_HEIGHT_M);

  return {
    heightM: Math.max(totalHeight, minHeightM + 2),
    minHeightM,
  };
}

function validCoordinate(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -85 &&
    lat <= 85
  );
}

function samePoint(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
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

function ringCenter(ring: readonly LonLat[]): LonLat {
  let lon = 0;
  let lat = 0;

  for (const p of ring) {
    lon += p[0];
    lat += p[1];
  }

  return [lon / ring.length, lat / ring.length];
}

/** Pure parser for Overpass building ways with `out geom`. */
export function parseOverpassBuildings(
  data: OverpassResponse,
): BuildingFootprint[] {
  const result: BuildingFootprint[] = [];
  const seen = new Set<number>();

  if (!Array.isArray(data.elements)) return result;

  for (const element of data.elements) {
    if (
      element.type !== 'way' ||
      !Number.isSafeInteger(element.id) ||
      seen.has(element.id) ||
      !element.tags?.building ||
      element.tags.building === 'no' ||
      !Array.isArray(element.geometry)
    ) {
      continue;
    }

    const points: LonLat[] = [];
    let invalid = false;

    for (const p of element.geometry) {
      if (!validCoordinate(p.lon, p.lat)) {
        invalid = true;
        break;
      }

      const coord: LonLat = [p.lon, p.lat];

      if (
        points.length === 0 ||
        !samePoint(points[points.length - 1], coord)
      ) {
        points.push(coord);
      }
    }

    if (invalid || points.length < 3) continue;

    if (samePoint(points[0], points[points.length - 1])) {
      points.pop();
    }

    if (points.length < 3) continue;

    const bounds = ringBounds(points);

    if (
      bounds.west === bounds.east ||
      bounds.south === bounds.north
    ) {
      continue;
    }

    const { heightM, minHeightM } =
      parseBuildingHeight(element.tags);

    result.push({
      id: `osm:way:${element.id}`,
      name:
        element.tags.name ??
        `OSM building ${element.id}`,
      ring: points,
      center: ringCenter(points),
      bounds,
      heightM,
      minHeightM,
    });

    seen.add(element.id);
  }

  return result;
}

/** Ray casting; points on an edge count as inside. */
export function pointInFootprint(
  lon: number,
  lat: number,
  ring: readonly LonLat[],
): boolean {
  if (ring.length < 3) return false;

  let inside = false;

  for (
    let i = 0, j = ring.length - 1;
    i < ring.length;
    j = i++
  ) {
    const a = ring[j];
    const b = ring[i];

    const cross =
      (lon - a[0]) * (b[1] - a[1]) -
      (lat - a[1]) * (b[0] - a[0]);

    const edgeScale = Math.max(
      Math.abs(b[0] - a[0]),
      Math.abs(b[1] - a[1]),
      1e-12,
    );

    if (
      Math.abs(cross) <= 1e-12 * edgeScale &&
      lon >= Math.min(a[0], b[0]) &&
      lon <= Math.max(a[0], b[0]) &&
      lat >= Math.min(a[1], b[1]) &&
      lat <= Math.max(a[1], b[1])
    ) {
      return true;
    }

    if (
      (a[1] > lat) !== (b[1] > lat) &&
      lon <
        ((b[0] - a[0]) * (lat - a[1])) /
          (b[1] - a[1]) +
          a[0]
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/** Approximate distance to a footprint edge in local metres. */
function edgeDistanceM(
  lon: number,
  lat: number,
  a: LonLat,
  b: LonLat,
): number {
  const latScale = EARTH_RADIUS_M * Math.PI / 180;
  const lonScale =
    latScale * Math.max(0.01, Math.cos(lat * Math.PI / 180));

  const ax = (a[0] - lon) * lonScale;
  const ay = (a[1] - lat) * latScale;
  const bx = (b[0] - lon) * lonScale;
  const by = (b[1] - lat) * latScale;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  const t = lengthSquared > 0
    ? Math.max(
        0,
        Math.min(1, -(ax * dx + ay * dy) / lengthSquared),
      )
    : 0;

  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Pure footprint collision.
 * clearanceM expands walls for the walker's physical radius.
 */
export function footprintBlocks(
  lon: number,
  lat: number,
  building: BuildingFootprint,
  clearanceM = 0.4,
): boolean {
  const clearance = Math.max(0, clearanceM);
  const latPad = clearance / 111_000;
  const lonPad =
    latPad / Math.max(
      0.01,
      Math.cos(lat * Math.PI / 180),
    );

  const { bounds, ring } = building;

  if (
    lon < bounds.west - lonPad ||
    lon > bounds.east + lonPad ||
    lat < bounds.south - latPad ||
    lat > bounds.north + latPad
  ) {
    return false;
  }

  if (pointInFootprint(lon, lat, ring)) return true;

  if (clearance === 0) return false;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];

    if (edgeDistanceM(lon, lat, a, b) <= clearance) {
      return true;
    }
  }

  return false;
}

/**
 * Synchronous collision query for Gemini's walker.
 * Returns false until building data has loaded.
 */
export function isBlocked(
  lon: number,
  lat: number,
  clearanceM = 0.4,
): boolean {
  if (!validCoordinate(lon, lat)) return false;

  return activeFootprints.some((building) =>
    footprintBlocks(lon, lat, building, clearanceM),
  );
}

export function getBuildingFootprints():
  readonly BuildingFootprint[] {
  return activeFootprints;
}

/** Remove only entities managed by this module. */
export function clearBuildings(): void {
  ++requestGeneration;
  pendingRequest?.abort();
  pendingRequest = null;

  if (activeViewer) {
    for (const entity of activeEntities) {
      activeViewer.entities.remove(entity);
    }
  }

  activeEntities = [];
  activeFootprints = [];
  activeViewer = null;
  setOfmCredit(null, false);
}

/**
 * Load local buildings using ordered Overpass mirrors.
 * Only call on teleport / area change, not every walker frame.
 *
 * If every mirror fails, falls back to OpenFreeMap vector
 * tiles (buildingsOfm.ts); existing buildings remain visible
 * only if that fails too.
 * Returns number of rendered buildings.
 */
export async function loadBuildingsAround(
  viewer: Viewer,
  lon: number,
  lat: number,
  radiusM = 350,
): Promise<number> {
  if (
    !validCoordinate(lon, lat) ||
    !Number.isFinite(radiusM) ||
    radiusM <= 0
  ) {
    throw new RangeError('Invalid building area');
  }

  const radius = Math.round(
    Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, radiusM)),
  );

  const generation = ++requestGeneration;
  pendingRequest?.abort();

  const controller = new AbortController();
  pendingRequest = controller;

  const query =
    `[out:json][timeout:25];` +
    `way["building"]["building"!="no"]` +
    `(around:${radius},${lat.toFixed(7)},${lon.toFixed(7)});` +
    `out geom;`;

  try {
    let parsed: BuildingFootprint[];
    let fromOpenFreeMap = false;

    try {
      const data = await fetchOverpassWithFallback(query, {
        signal: controller.signal,
      });

      if (generation !== requestGeneration) return 0;

      parsed = parseOverpassBuildings(data)
        .slice(0, MAX_BUILDINGS);
    } catch (overpassError) {
      if (
        generation !== requestGeneration ||
        controller.signal.aborted
      ) {
        throw overpassError;
      }

      // Last resort (Lumi): every Overpass mirror failed, so read
      // the same area from keyless OpenFreeMap z14 vector tiles.
      try {
        parsed = await fetchOfmBuildings(lon, lat, radius, {
          signal: controller.signal,
          maxBuildings: MAX_BUILDINGS,
        });
      } catch (ofmError) {
        if (generation !== requestGeneration) throw ofmError;
        throw new Error(
          `${String(overpassError)}\nOpenFreeMap fallback failed: ${String(ofmError)}`,
        );
      }

      if (generation !== requestGeneration) return 0;
      fromOpenFreeMap = true;
    }

    const nextEntities: Entity[] = [];
    const renderedIds = new Set<string>();

    const discard = (): number => {
      for (const entity of nextEntities) {
        viewer.entities.remove(entity);
      }
      return 0;
    };

    // HeightAt caches shared Terrarium tiles.
    // Resolve elevations sequentially rather than
    // starting hundreds of simultaneous tile downloads.
    for (const building of parsed) {
      if (generation !== requestGeneration) {
        return discard();
      }

      const [centerLon, centerLat] = building.center;

      const cartographic =
        Cartographic.fromDegrees(centerLon, centerLat);

      let groundHeight =
        viewer.scene.globe.getHeight(cartographic);

      if (
        groundHeight === undefined ||
        !Number.isFinite(groundHeight)
      ) {
        try {
          groundHeight = await heightAt(
            centerLon,
            centerLat,
          );
        } catch {
          continue;
        }
      }

      if (generation !== requestGeneration) {
        return discard();
      }

      const coordinates: number[] = [];

      for (const [x, y] of building.ring) {
        coordinates.push(x, y);
      }

      const hierarchy = new PolygonHierarchy(
        Cartesian3.fromDegreesArray(coordinates),
      );

      const bottom =
        groundHeight + building.minHeightM;
      const roof =
        groundHeight + building.heightM;

      const entity = viewer.entities.add({
        name: building.name,
        polygon: {
          hierarchy,
          height: roof,
          extrudedHeight: bottom,
          material: Color.fromCssColorString(
            '#a7b8c8',
          ).withAlpha(0.85),
          outline: false,
          closeTop: true,
          closeBottom: true,
        },
        properties: {
          osmId: building.id,
        },
      });

      nextEntities.push(entity);
      renderedIds.add(building.id);
    }

    if (generation !== requestGeneration) {
      return discard();
    }

    // Atomic replacement: old buildings remain until
    // the new set is completely prepared.
    if (activeViewer) {
      for (const entity of activeEntities) {
        activeViewer.entities.remove(entity);
      }
    }

    activeViewer = viewer;
    activeEntities = nextEntities;
    setOfmCredit(viewer, fromOpenFreeMap);
    activeFootprints = parsed.filter((building) =>
      renderedIds.has(building.id),
    );

    return nextEntities.length;
  } catch (error) {
    // New teleport / clearBuildings: not a network failure.
    if (generation !== requestGeneration) return 0;
    throw error;
  } finally {
    if (pendingRequest === controller) {
      pendingRequest = null;
    }
  }
}
