/**
 * Earth Walker — OSM buildings
 * GPT-6 / lane 3
 *
 * Keyless OpenStreetMap footprints from public Overpass.
 * Cesium polygons use absolute metres on Claude's terrain datum.
 * Collision uses the original lon/lat footprints, independent
 * of Cesium's asynchronous entity rendering.
 *
 * Scope v1: closed OSM building ways. Multipolygon relations,
 * roof geometry and interior courtyards are future work.
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

export const OVERPASS_URL =
  'https://overpass-api.de/api/interpreter';

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

let activeFootprints: BuildingFootprint[] = [];
let activeEntities: Entity[] = [];
let activeViewer: Viewer | null = null;
let requestGeneration = 0;
let pendingRequest: AbortController | null = null;

/** Parse OSM length values in metres. Supports "12", "12 m", "40 ft". */
export function parseLength(
  raw: string | undefined,
): number | null {
  if (!raw) return null;

  const value = raw.trim().replace(',', '.');
  const match = /^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|foot|')?$/i.exec(
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

  const totalHeight =
    parseLength(tags.height) ??
    (levels(tags['building:levels']) !== null
      ? levels(tags['building:levels'])! * METRES_PER_LEVEL
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

/**
 * Pure parser for Overpass "way[building]; out geom".
 *
 * Invalid geometries are skipped rather than creating
 * invisible collision walls.
 */
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

    // OSM closed ways repeat the first coordinate.
    if (samePoint(points[0], points[points.length - 1])) {
      points.pop();
    }

    if (points.length < 3) continue;

    const bounds = ringBounds(points);

    // Exclude zero-area geometry.
    if (
      bounds.west === bounds.east ||
      bounds.south === bounds.north
    ) continue;

    const { heightM, minHeightM } =
      parseBuildingHeight(element.tags);

    const building: BuildingFootprint = {
      id: `osm:way:${element.id}`,
      name:
        element.tags.name ??
        `OSM building ${element.id}`,
      ring: points,
      center: ringCenter(points),
      bounds,
      heightM,
      minHeightM,
    };

    seen.add(element.id);
    result.push(building);
  }

  return result;
}

/** Ray casting; points on an edge are also considered inside. */
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
    latPad / Math.max(0.01, Math.cos(lat * Math.PI / 180));

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

/** Read-only current loaded footprints for debugging or future navmesh. */
export function getBuildingFootprints():
  readonly BuildingFootprint[] {
  return activeFootprints;
}

/** Remove only the entities managed by this module. */
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
}

/**
 * Load nearby OSM buildings from keyless Overpass and
 * extrude them relative to the sampled terrain.
 *
 * Call on teleport / area change, NOT every walker frame.
 * radiusM is capped to protect the shared public API.
 *
 * Returns number of successfully rendered buildings.
 * Propagates fetch errors so the caller can show a status.
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

  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Overpass request failed (${response.status})`,
      );
    }

    const data = (await response.json()) as OverpassResponse;
    const parsed = parseOverpassBuildings(data)
      .slice(0, MAX_BUILDINGS);

    const nextEntities: Entity[] = [];

    // Do not start hundreds of simultaneous tile downloads.
    // Claude's heightAt() internally caches shared terrain tiles.
    for (const building of parsed) {
      if (generation !== requestGeneration) return 0;

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
          // Terrain may temporarily be unavailable.
          // Omit this extrusion rather than place it at sea level.
          continue;
        }
      }

      if (generation !== requestGeneration) return 0;

      const coordinates: number[] = [];

      for (const [x, y] of building.ring) {
        coordinates.push(x, y);
      }

      const hierarchy = new PolygonHierarchy(
        Cartesian3.fromDegreesArray(coordinates),
      );

      const bottom = groundHeight + building.minHeightM;
      const roof = groundHeight + building.heightM;

      const entity = viewer.entities.add({
        name: building.name,
        polygon: {
          hierarchy,
          height: roof,
          extrudedHeight: bottom,
          material: Color.fromCssColorString('#a7b8c8')
            .withAlpha(0.85),
          outline: false,
          closeTop: true,
          closeBottom: true,
        },
        properties: {
          osmId: building.id,
        },
      });

      nextEntities.push(entity);
    }

    // A later teleport may supersede this area.
    if (generation !== requestGeneration) {
      for (const entity of nextEntities) {
        viewer.entities.remove(entity);
      }
      return 0;
    }

    if (activeViewer) {
      for (const entity of activeEntities) {
        activeViewer.entities.remove(entity);
      }
    }

    activeViewer = viewer;
    activeEntities = nextEntities;

    // Include only successfully placed buildings in collision.
    const rendered = new Set(
      nextEntities.map((entity) =>
        entity.properties?.osmId?.getValue(
          viewer.clock.currentTime,
        ) as string,
      ),
    );

    activeFootprints = parsed.filter((building) =>
      rendered.has(building.id),
    );

    return nextEntities.length;
  } finally {
    if (pendingRequest === controller) {
      pendingRequest = null;
    }
  }
}

