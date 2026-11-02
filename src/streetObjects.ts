// src/streetObjects.ts — trees and street furniture (owner: Claude).
//
// Keyless OpenStreetMap data through GPT-6's Overpass client (same mirror
// fallback as the buildings):
//   - mapped objects: trees, street lamps, benches, fire hydrants, bollards
//   - tree rows (natural=tree_row), placed every ~8 m along the line
//   - forests, woods and parks, filled with seeded scattered trees
//
// Everything is drawn as simple low-poly shapes built from Cesium's own
// geometry (no downloaded models, no licences to track), batched into ONE
// Primitive per loaded area with a colour per part. Bases sit on the terrain
// via tryHeightAt/heightAt, and trunks and poles extend SINK_M below ground
// so small mismatches with the drawn terrain mesh never leave them floating.
//
// Collision: isStreetObstacle(lon, lat) answers for trunks, poles, hydrants,
// bollards and benches (small circles), for the walker. The chase camera
// should keep using the buildings-only isBlocked, so thin trunks passing
// behind the avatar don't yank the camera in.

import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  Credit,
  CylinderGeometry,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  Transforms,
  type Viewer,
} from 'cesium';

import { fetchOverpassWithFallback, parseLength, type OverpassFetchOptions } from './buildings';
import { heightAt, tryHeightAt } from './terrain';

// ---- tuning -----------------------------------------------------------------

/** Most objects drawn per loaded area; nearest real (mapped) objects win. */
export const MAX_OBJECTS = 2500;
/** Scatter spacing inside forests/woods and parks, metres. */
export const FOREST_SPACING_M = 7;
export const PARK_SPACING_M = 18;
/** Spacing of trees along a tree_row, metres. */
export const ROW_SPACING_M = 8;
/** Trunks and poles continue this far below the ground. */
export const SINK_M = 1.5;

const M_PER_DEG_LAT = 111320;
const MAX_SCATTER_PER_AREA = 1500;

const OSM_CREDIT_HTML =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Trees &amp; street furniture © OpenStreetMap contributors</a>';

// ---- types ------------------------------------------------------------------

export type LonLat = readonly [lon: number, lat: number];
export type Tags = Record<string, string | undefined>;

export type StreetKind = 'tree' | 'conifer' | 'lamp' | 'bench' | 'hydrant' | 'bollard';

export interface StreetPoint {
  id: string;
  lon: number;
  lat: number;
  tags: Tags;
}
export interface StreetArea {
  id: string;
  ring: LonLat[];
  tags: Tags;
}
export interface StreetLine {
  id: string;
  line: LonLat[];
  tags: Tags;
}
export interface StreetFeatures {
  points: StreetPoint[];
  areas: StreetArea[];
  lines: StreetLine[];
}

export interface StreetObject {
  id: string;
  kind: StreetKind;
  lon: number;
  lat: number;
  /** Overall height above ground, metres. */
  height: number;
  /** Trunk / pole / body radius, metres (also the collision radius). */
  radius: number;
  /** Crown radius for trees, metres (0 otherwise). */

  crown: number;
  /** Rotation about the vertical, radians (benches; varies shapes a little). */
  yaw: number;
  /** 0..1, picks a shade so neighbours don't look stamped. */
  tint: number;
  /** True if it came from a mapped OSM object rather than scatter. */
  mapped: boolean;
}

// ---- seeded randomness --------------------------------------------------------

/** FNV-1a string hash, so each object's look is stable across reloads. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good enough for visual variety. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- parsing ----------------------------------------------------------------

/** Kind for a mapped OSM node, or null if it isn't something we draw. */
export function classifyPoint(tags: Tags): StreetKind | null {
  if (tags.natural === 'tree') return tags.leaf_type === 'needleleaved' ? 'conifer' : 'tree';
  if (tags.highway === 'street_lamp') return 'lamp';
  if (tags.amenity === 'bench' || tags.leisure === 'picnic_table') return 'bench';
  if (tags.emergency === 'fire_hydrant') return 'hydrant';
  if (tags.barrier === 'bollard') return 'bollard';
  return null;
}

function isTreeArea(tags: Tags): boolean {
  return tags.landuse === 'forest' || tags.natural === 'wood' || tags.leisure === 'park';
}

type Geo = Array<{ lon: number; lat: number }>;

function toRing(geometry: Geo | undefined): LonLat[] | null {
  if (!geometry || geometry.length < 4) return null;
  const pts = geometry.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat)).map((p) => [p.lon, p.lat] as const);
  if (pts.length < 4) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return null; // not closed: not an area
  return pts.slice(0, -1);
}

/** Pull the drawable features out of an Overpass `out geom` response. */
export function parseStreetFeatures(data: unknown): StreetFeatures {
  const out: StreetFeatures = { points: [], areas: [], lines: [] };

  const elements = (data as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return out;

  for (const raw of elements) {
    const el = raw as {
      type?: string;
      id?: number;
      lat?: number;
      lon?: number;
      tags?: Tags;
      geometry?: Geo;
      members?: Array<{ role?: string; geometry?: Geo }>;
    };
    const tags = el.tags ?? {};
    const id = `${el.type}/${el.id}`;

    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon) && classifyPoint(tags)) {
      out.points.push({ id, lon: el.lon!, lat: el.lat!, tags });
    } else if (el.type === 'way' && tags.natural === 'tree_row' && el.geometry && el.geometry.length >= 2) {
      out.lines.push({ id, line: el.geometry.map((p) => [p.lon, p.lat] as const), tags });
    } else if (el.type === 'way' && isTreeArea(tags)) {
      const ring = toRing(el.geometry);
      if (ring) out.areas.push({ id, ring, tags });
    } else if (el.type === 'relation' && isTreeArea(tags) && el.members) {
      // Multipolygons: use each closed outer member. Outers split across
      // several open ways are skipped (joining them is a v2 job).
      el.members.forEach((m, i) => {
        if (m.role !== 'outer') return;
        const ring = toRing(m.geometry);
        if (ring) out.areas.push({ id: `${id}#${i}`, ring, tags });
      });
    }
  }
  return out;
}

// ---- geometry helpers ---------------------------------------------------------

/** Local metres (east, north) of (lon, lat) relative to an origin. */
export function toLocal(lon: number, lat: number, lon0: number, lat0: number): [number, number] {
  const mPerLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [(lon - lon0) * mPerLon, (lat - lat0) * M_PER_DEG_LAT];
}

export function fromLocal(x: number, y: number, lon0: number, lat0: number): [number, number] {
  const mPerLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [lon0 + x / mPerLon, lat0 + y / M_PER_DEG_LAT];
}

/** Even-odd point-in-polygon on local coordinates. */
export function pointInRing(x: number, y: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Seeded jittered-grid scatter inside an area, clipped to the load circle.
 * Returns lon/lat points.
 */
export function scatterInArea(
  ring: readonly LonLat[],
  spacingM: number,
  rand: () => number,
  lon0: number,
  lat0: number,
  radiusM: number,
  max = MAX_SCATTER_PER_AREA,
): LonLat[] {
  const local = ring.map(([lon, lat]) => toLocal(lon, lat, lon0, lat0));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of local) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  minX = Math.max(minX, -radiusM);
  minY = Math.max(minY, -radiusM);
  maxX = Math.min(maxX, radiusM);
  maxY = Math.min(maxY, radiusM);

  const out: LonLat[] = [];
  for (let gy = minY; gy <= maxY; gy += spacingM) {
    for (let gx = minX; gx <= maxX; gx += spacingM) {
      const x = gx + (rand() - 0.5) * spacingM * 0.8;
      const y = gy + (rand() - 0.5) * spacingM * 0.8;
      if (x * x + y * y > radiusM * radiusM) continue;
      if (!pointInRing(x, y, local)) continue;

      out.push(fromLocal(x, y, lon0, lat0));
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Points every `spacingM` along a polyline (tree rows), starting at its first vertex. */
export function pointsAlongLine(line: readonly LonLat[], spacingM: number, lon0: number, lat0: number): LonLat[] {
  const out: LonLat[] = [];
  if (line.length === 0 || !(spacingM > 0)) return out;
  let next = 0; // distance along the line of the next point
  let acc = 0; // distance along the line at the start of this segment
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = toLocal(line[i - 1][0], line[i - 1][1], lon0, lat0);
    const [bx, by] = toLocal(line[i][0], line[i][1], lon0, lat0);
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    while (next <= acc + len + 1e-9) {
      const t = (next - acc) / len;
      out.push(fromLocal(ax + (bx - ax) * t, ay + (by - ay) * t, lon0, lat0));
      next += spacingM;
    }
    acc += len;
  }
  return out;
}

// ---- sizing -----------------------------------------------------------------

/** Tree dimensions from OSM tags where present, seeded defaults otherwise. */
export function treeDims(
  tags: Tags,
  rand: () => number,
  conifer: boolean,
): { height: number; radius: number; crown: number } {
  const tagged = parseLength(tags.height);
  const height = tagged !== null && tagged >= 2 && tagged <= 60 ? tagged : (conifer ? 9 : 6) + rand() * 9;
  const crownTag = parseLength(tags.diameter_crown);
  const crown =
    crownTag !== null && crownTag > 0.5 && crownTag < 40
      ? crownTag / 2
      : height * (conifer ? 0.2 : 0.3) * (0.85 + rand() * 0.3);
  const circumference = parseLength(tags.circumference);
  const radius =
    circumference !== null && circumference > 0.1 && circumference < 15
      ? circumference / (2 * Math.PI)
      : 0.1 + height * 0.012;
  return { height, radius, crown };
}

function objectFor(kind: StreetKind, id: string, lon: number, lat: number, tags: Tags, mapped: boolean): StreetObject {
  const rand = seededRandom(hashString(id));
  const yaw = rand() * Math.PI * 2;
  const tint = rand();
  switch (kind) {
    case 'tree':
    case 'conifer': {
      const d = treeDims(tags, rand, kind === 'conifer');
      return { id, kind, lon, lat, ...d, yaw, tint, mapped };
    }
    case 'lamp':
      return { id, kind, lon, lat, height: 5.5 + rand() * 2, radius: 0.1, crown: 0, yaw, tint, mapped };
    case 'bench':
      return { id, kind, lon, lat, height: 0.85, radius: 0.85, crown: 0, yaw, tint, mapped };
    case 'hydrant':
      return { id, kind, lon, lat, height: 0.8, radius: 0.18, crown: 0, yaw, tint, mapped };
    case 'bollard':
      return { id, kind, lon, lat, height: 0.95, radius: 0.12, crown: 0, yaw, tint, mapped };
  }
}

function coniferShare(tags: Tags): number {
  if (tags.leaf_type === 'needleleaved') return 1;
  if (tags.leaf_type === 'broadleaved') return 0;
  return tags.leisure === 'park' ? 0.15 : 0.5;
}

export interface PlanOptions {
  maxObjects?: number;
  /** Skip scattered trees here (e.g. inside building footprints). */
  exclude?: (lon: number, lat: number) => boolean;
}

/**
 * Turn parsed features into the objects to draw: mapped objects first
 * (nearest first), then tree-row and scatter trees (nearest first), capped.
 */
export function planStreetObjects(
  features: StreetFeatures,
  lon0: number,
  lat0: number,
  radiusM: number,
  opts: PlanOptions = {},
): StreetObject[] {
  const max = opts.maxObjects ?? MAX_OBJECTS;

  const within = (lon: number, lat: number): boolean => {
    const [x, y] = toLocal(lon, lat, lon0, lat0);
    return x * x + y * y <= radiusM * radiusM;
  };
  const dist2 = (o: StreetObject): number => {
    const [x, y] = toLocal(o.lon, o.lat, lon0, lat0);
    return x * x + y * y;
  };

  const mapped: StreetObject[] = [];
  for (const p of features.points) {
    const kind = classifyPoint(p.tags);
    if (kind && within(p.lon, p.lat)) mapped.push(objectFor(kind, p.id, p.lon, p.lat, p.tags, true));
  }

  const filler: StreetObject[] = [];
  for (const row of features.lines) {
    pointsAlongLine(row.line, ROW_SPACING_M, lon0, lat0).forEach(([lon, lat], i) => {
      if (!within(lon, lat)) return;
      const kind: StreetKind = row.tags.leaf_type === 'needleleaved' ? 'conifer' : 'tree';
      mapped.push(objectFor(kind, `${row.id}@${i}`, lon, lat, row.tags, true));
    });
  }
  for (const area of features.areas) {
    const rand = seededRandom(hashString(area.id));
    const spacing = area.tags.leisure === 'park' ? PARK_SPACING_M : FOREST_SPACING_M;
    const share = coniferShare(area.tags);
    scatterInArea(area.ring, spacing, rand, lon0, lat0, radiusM).forEach(([lon, lat], i) => {
      if (opts.exclude?.(lon, lat)) return;
      const kind: StreetKind = rand() < share ? 'conifer' : 'tree';
      filler.push(objectFor(kind, `${area.id}~${i}`, lon, lat, {}, false));
    });
  }

  mapped.sort((a, b) => dist2(a) - dist2(b));
  filler.sort((a, b) => dist2(a) - dist2(b));
  return mapped.concat(filler).slice(0, max);
}

// ---- shapes -----------------------------------------------------------------

export type PartShape = 'cylinder' | 'cone' | 'ball' | 'box';

export interface PartSpec {
  shape: PartShape;
  /** Full size along x (east after yaw), y (north after yaw), z (up), metres. */
  size: [number, number, number];
  /** Part centre in the object's local frame, metres (z up from the ground). */
  center: [number, number, number];
  color: string;
}

const TRUNK = '#5d4532';
const POLE = '#3a3d42';

function mix(a: string, b: string, t: number): string {
  return Color.lerp(Color.fromCssColorString(a), Color.fromCssColorString(b), t, new Color()).toCssHexString();
}

/** The low-poly parts that make up one object (pure; unit-tested). */
export function partsFor(o: StreetObject): PartSpec[] {
  switch (o.kind) {
    case 'tree': {
      const trunkTop = o.height * 0.45;

      const crownH = o.crown * 2.2;
      return [
        { shape: 'cylinder', size: [o.radius * 2, o.radius * 2, trunkTop + SINK_M], center: [0, 0, (trunkTop - SINK_M) / 2], color: TRUNK },
        { shape: 'ball', size: [o.crown * 2, o.crown * 2, crownH], center: [0, 0, o.height - crownH / 2], color: mix('#3f6f2a', '#6b8f3a', o.tint) },
      ];
    }
    case 'conifer': {
      const trunkTop = o.height * 0.25;
      const coneBase = o.height * 0.15;
      return [
        { shape: 'cylinder', size: [o.radius * 2, o.radius * 2, trunkTop + SINK_M], center: [0, 0, (trunkTop - SINK_M) / 2], color: TRUNK },
        { shape: 'cone', size: [o.crown * 2, o.crown * 2, o.height - coneBase], center: [0, 0, (o.height + coneBase) / 2], color: mix('#2b4f2c', '#3f6b3a', o.tint) },
      ];
    }
    case 'lamp':
      return [
        { shape: 'cylinder', size: [0.16, 0.16, o.height + SINK_M], center: [0, 0, (o.height - SINK_M) / 2], color: POLE },
        { shape: 'box', size: [0.55, 0.28, 0.16], center: [0.2, 0, o.height], color: '#f3e6b0' },
      ];
    case 'bench':
      return [
        { shape: 'box', size: [1.7, 0.45, 0.42], center: [0, 0, 0.21], color: mix('#6e4f33', '#8a6a48', o.tint) },
        { shape: 'box', size: [1.7, 0.07, 0.42], center: [0, -0.2, 0.63], color: mix('#6e4f33', '#8a6a48', o.tint) },
      ];
    case 'hydrant':
      return [
        { shape: 'cylinder', size: [0.3, 0.3, 0.7 + SINK_M], center: [0, 0, (0.7 - SINK_M) / 2], color: '#c0392b' },
        { shape: 'ball', size: [0.32, 0.32, 0.22], center: [0, 0, 0.72], color: '#c0392b' },
      ];
    case 'bollard':
      return [{ shape: 'cylinder', size: [0.22, 0.22, o.height + SINK_M], center: [0, 0, (o.height - SINK_M) / 2], color: '#4a4d52' }];
  }
}

// ---- collision index ------------------------------------------------------------

const CELL_M = 8;

export interface ObstacleIndex {
  isBlocked(lon: number, lat: number, clearanceM?: number): boolean;
  readonly size: number;
}

/** Spatial hash of trunk/pole circles for fast per-frame collision checks. */
export function createObstacleIndex(objects: readonly StreetObject[], lon0: number, lat0: number): ObstacleIndex {
  const cells = new Map<string, Array<[number, number, number]>>();
  for (const o of objects) {
    const [x, y] = toLocal(o.lon, o.lat, lon0, lat0);
    const key = `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = []));
    cell.push([x, y, o.radius]);
  }
  return {
    size: objects.length,
    isBlocked(lon, lat, clearanceM = 0.4) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
      const [x, y] = toLocal(lon, lat, lon0, lat0);
      const cx = Math.floor(x / CELL_M);
      const cy = Math.floor(y / CELL_M);
      for (let i = cx - 1; i <= cx + 1; i++) {
        for (let j = cy - 1; j <= cy + 1; j++) {
          const cell = cells.get(`${i},${j}`);
          if (!cell) continue;

          for (const [ox, oy, r] of cell) {
            const reach = r + clearanceM;
            if ((x - ox) ** 2 + (y - oy) ** 2 < reach * reach) return true;
          }
        }
      }
      return false;
    },
  };
}

// ---- Cesium rendering and lifecycle -------------------------------------------

let geometries: Record<PartShape, CylinderGeometry | EllipsoidGeometry | BoxGeometry> | null = null;

/** Unit-sized shapes, scaled per instance by the model matrix. */
function unitGeometries(): Record<PartShape, CylinderGeometry | EllipsoidGeometry | BoxGeometry> {
  if (geometries) return geometries;
  const vertexFormat = PerInstanceColorAppearance.VERTEX_FORMAT;
  geometries = {
    cylinder: new CylinderGeometry({ length: 1, topRadius: 0.5, bottomRadius: 0.5, slices: 8, vertexFormat }),
    cone: new CylinderGeometry({ length: 1, topRadius: 0, bottomRadius: 0.5, slices: 8, vertexFormat }),
    ball: new EllipsoidGeometry({ radii: new Cartesian3(0.5, 0.5, 0.5), stackPartitions: 6, slicePartitions: 8, vertexFormat }),
    box: BoxGeometry.fromDimensions({ dimensions: new Cartesian3(1, 1, 1), vertexFormat }),
  };
  return geometries;
}

let activeViewer: Viewer | null = null;
let activePrimitive: Primitive | null = null;
let activeIndex: ObstacleIndex | null = null;
let credit: Credit | null = null;

let generation = 0;
let pending: AbortController | null = null;

/** Synchronous collision query for the walker: trunks, poles, benches... */
export function isStreetObstacle(lon: number, lat: number, clearanceM = 0.4): boolean {
  return activeIndex?.isBlocked(lon, lat, clearanceM) ?? false;
}

function setCredit(viewer: Viewer | null): void {
  if (activeViewer && credit) activeViewer.creditDisplay.removeStaticCredit(credit);
  if (viewer) {
    credit ??= new Credit(OSM_CREDIT_HTML);
    viewer.creditDisplay.addStaticCredit(credit);
  }
}

/** Remove everything this module drew and cancel any load in progress. */
export function clearStreetObjects(): void {
  ++generation;
  pending?.abort();
  pending = null;
  if (activeViewer && activePrimitive) activeViewer.scene.primitives.remove(activePrimitive);
  setCredit(null);
  activeViewer = null;
  activePrimitive = null;
  activeIndex = null;
}

export function streetObjectsQuery(lon: number, lat: number, radiusM: number): string {
  const a = `(around:${Math.round(radiusM)},${lat.toFixed(7)},${lon.toFixed(7)})`;
  return (
    `[out:json][timeout:25];(` +
    `node["natural"="tree"]${a};` +
    `node["highway"="street_lamp"]${a};` +
    `node["amenity"="bench"]${a};` +
    `node["leisure"="picnic_table"]${a};` +
    `node["emergency"="fire_hydrant"]${a};` +
    `node["barrier"="bollard"]${a};` +
    `way["natural"="tree_row"]${a};` +
    `way["landuse"="forest"]${a};way["natural"="wood"]${a};way["leisure"="park"]${a};` +
    `relation["landuse"="forest"]${a};relation["natural"="wood"]${a};relation["leisure"="park"]${a};` +
    `);out geom;`
  );
}

function whenReady(viewer: Viewer, primitive: Primitive, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    const off = viewer.scene.postRender.addEventListener(() => {
      if (primitive.ready || performance.now() - start > timeoutMs) {
        off();
        resolve(primitive.ready);
      }
    });
  });
}

export interface LoadStreetObjectsOptions {
  radiusM?: number;
  maxObjects?: number;
  exclude?: (lon: number, lat: number) => boolean;
  overpass?: OverpassFetchOptions;
}

/**
 * Load trees and street furniture around (lon, lat). Call on the same
 * triggers as loadBuildingsAround (not every frame). The previous set stays
 * visible until the new one has finished building. Returns objects drawn.
 */
export async function loadStreetObjectsAround(
  viewer: Viewer,
  lon: number,
  lat: number,
  opts: LoadStreetObjectsOptions = {},
): Promise<number> {
  const radiusM = Math.max(25, Math.min(800, opts.radiusM ?? 350));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new RangeError('Invalid street-object area');

  const gen = ++generation;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const stale = (): boolean => gen !== generation;

  try {
    const data = await fetchOverpassWithFallback(streetObjectsQuery(lon, lat, radiusM), {
      ...opts.overpass,
      signal: controller.signal,
    });
    if (stale()) return 0;

    const objects = planStreetObjects(parseStreetFeatures(data), lon, lat, radiusM, {
      maxObjects: opts.maxObjects,
      exclude: opts.exclude,
    });

    const geo = unitGeometries();
    const instances: GeometryInstance[] = [];
    const placed: StreetObject[] = [];
    const enu = new Matrix4();
    const yawM = new Matrix4();
    const local = new Matrix4();
    const scale = new Matrix4();
    const base = new Cartesian3();
    const colors = new Map<string, ColorGeometryInstanceAttribute>();

    for (const o of objects) {
      let ground = tryHeightAt(o.lon, o.lat);
      if (ground === undefined) {
        try {
          ground = await heightAt(o.lon, o.lat); // tiles are shared, so only the first few actually download
        } catch {
          continue;
        }
        if (stale()) return 0;
      }
      Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(o.lon, o.lat, ground, undefined, base), undefined, enu);
      Matrix4.multiply(enu, Matrix4.fromRotation(Matrix3.fromRotationZ(o.yaw), yawM), yawM);
      for (const part of partsFor(o)) {
        let color = colors.get(part.color);
        if (!color) colors.set(part.color, (color = ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(part.color))));
        Matrix4.fromTranslation(new Cartesian3(...part.center), local);
        Matrix4.fromScale(new Cartesian3(...part.size), scale);
        const modelMatrix = Matrix4.multiply(yawM, Matrix4.multiply(local, scale, local), new Matrix4());
        instances.push(new GeometryInstance({ geometry: geo[part.shape], modelMatrix, attributes: { color } }));
      }
      placed.push(o);
    }

    if (stale()) return 0;

    const next =
      instances.length > 0
        ? new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({ translucent: false }),
            asynchronous: true,
            allowPicking: false,
            releaseGeometryInstances: true,
          })
        : null;

    if (next) {
      viewer.scene.primitives.add(next);
      await whenReady(viewer, next);
      if (stale()) {
        viewer.scene.primitives.remove(next);
        return 0;
      }
    }

    // Atomic swap: the old set disappears only once the new one is drawn.
    if (activeViewer && activePrimitive) activeViewer.scene.primitives.remove(activePrimitive);
    setCredit(next ? viewer : null);
    activeViewer = next ? viewer : null;
    activePrimitive = next;
    activeIndex = createObstacleIndex(placed, lon, lat);
    return placed.length;
  } catch (error) {
    if (stale()) return 0;
    throw error;
  } finally {
    if (pending === controller) pending = null;
  }
}
