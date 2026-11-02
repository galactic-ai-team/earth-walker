/**
 * Earth Walker — OSM roads + sidewalks
 * Nova / lane 5 (street layer, roads half)
 *
 * Keyless highway geometry from public Overpass instances, reusing
 * lane 3's fetchOverpassWithFallback (ordered mirrors, timeout,
 * cancellation). Trees and street furniture are lane 1's streetObjects
 * — this module only handles highway ways.
 *
 * Rendering: each way's centreline is subdivided to ~10 m, every point
 * is height-sampled from lane 1's terrain (tryHeightAt fast path,
 * heightAt fallback), and a flat ribbon of the way's real width is
 * built in a local ENU frame and merged into ONE Cesium Primitive
 * with per-instance colours. Lifts above the sampled ground: roads
 * +0.06 m, crosswalks +0.09 m, paths +0.05 m, sidewalks +0.15 m — the
 * sidewalk/road step is what reads as a kerb at street level.
 *
 * Loading: attachRoadsAutoLoad() polls on postRender every ~500 ms
 * (the same trick buildings uses) so roads refresh during a long
 * walk, not only when the camera stops; the loader's own 100 m
 * centre guard keeps those checks cheap.
 *
 * Known v1 limits (same caveat Claude documented for the walker):
 * heights are sampled, the drawn terrain mesh is coarser, so on steep
 * ground a ribbon can dip slightly under the mesh between samples.
 * Sidewalks mapped as tags on a road way (sidewalk=both etc.) get no
 * separate geometry — only sidewalks mapped as their own ways render.
 * Crosswalks are pale ribbons; stripes are future work.
 */

import {
  BoundingSphere,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
  Transforms,
  type Viewer,
} from 'cesium';

import {
  fetchOverpassWithFallback,
  parseLength,
  type OverpassFetchOptions,
} from './buildings';
import { heightAt, tryHeightAt } from './terrain';

export type LonLat = readonly [lon: number, lat: number];
export type Tags = Record<string, string | undefined>;
export type RoadKind = 'road' | 'sidewalk' | 'path' | 'crosswalk';

export interface RoadWay {
  id: string;
  osmId: number;
  kind: RoadKind;
  name?: string;
  widthM: number;
  points: LonLat[];
}

export const DEFAULT_RADIUS_M = 350;
export const MAX_ROADS = 600;
/** Subdivision step for height sampling along a centreline, metres. */
export const SUBDIVIDE_M = 10;
/** A reload centred within this distance of the last one is skipped. */
export const RELOAD_WITHIN_M = 100;
/** Above this height over the ground, roads are cleared, not loaded. */
export const ROADS_MAX_HEIGHT_M = 2000;

export const ROAD_COLORS: Record<RoadKind, string> = {
  road: '#333336',
  sidewalk: '#a3a3a0',
  path: '#7a7268',
  crosswalk: '#d9d9d6',
};

export const ROAD_LIFTS_M: Record<RoadKind, number> = {
  road: 0.06,
  sidewalk: 0.15,
  path: 0.05,
  crosswalk: 0.09,
};

const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;

// ---- classification (pure; unit-tested) ----------------------------------------

const ROAD_WIDTHS_M: Record<string, number> = {
  motorway: 11,
  motorway_link: 6,
  trunk: 10.5,
  trunk_link: 6,
  primary: 10,
  primary_link: 5.5,
  secondary: 9,
  secondary_link: 5,
  tertiary: 8,
  tertiary_link: 5,
  unclassified: 6.5,
  residential: 6.5,
  living_street: 6,
  service: 4,
  road: 6,
  track: 3,
  pedestrian: 5,
};

/**
 * Classify an OSM highway way and decide its render width.
 * Width precedence: explicit width tag, then lanes x 3.4 m (roads
 * only), then the class default. Returns null for anything that
 * isn't ribbon geometry (areas, stops, platforms, ...).
 */
export function classifyHighway(
  tags: Tags,
): { kind: RoadKind; widthM: number } | null {
  const hw = tags.highway;
  if (!hw || tags.area === 'yes') return null;

  let kind: RoadKind;
  let fallback: number;
  if (hw === 'footway' || hw === 'sidewalk') {
    if (tags.footway === 'crossing') {
      kind = 'crosswalk';
      fallback = 2.5;
    } else if (hw === 'sidewalk' || tags.footway === 'sidewalk') {
      kind = 'sidewalk';
      fallback = 1.8;
    } else {
      kind = 'path';
      fallback = 1.8;
    }
  } else if (
    hw === 'path' ||
    hw === 'cycleway' ||
    hw === 'bridleway' ||
    hw === 'steps' ||
    hw === 'corridor'
  ) {
    kind = 'path';
    fallback = hw === 'cycleway' ? 2.5 : hw === 'steps' ? 2 : 1.8;
  } else if (ROAD_WIDTHS_M[hw] !== undefined) {
    kind = 'road';
    fallback = ROAD_WIDTHS_M[hw];
  } else {
    return null;
  }

  const tagged = parseLength(tags.width);
  if (typeof tagged === 'number' && Number.isFinite(tagged) && tagged > 0) {
    return { kind, widthM: Math.min(30, tagged) };
  }
  if (kind === 'road') {
    const lanes = Number.parseInt(tags.lanes ?? '', 10);
    if (Number.isFinite(lanes) && lanes >= 1) {
      return { kind, widthM: Math.min(20, Math.max(3, lanes * 3.4)) };
    }
  }
  return { kind, widthM: fallback };
}

// ---- Overpass parsing (pure; unit-tested) ---------------------------------------

/** Extract classified road ways from an Overpass `out geom;` payload. */
export function parseOverpassRoads(data: unknown): RoadWay[] {
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { elements?: unknown }).elements)
  ) {
    return [];
  }
  const elements = (
    data as {
      elements: Array<{
        type: string;
        id: number;
        tags?: Tags;
        geometry?: Array<{ lon: number; lat: number }>;
      }>;
    }
  ).elements;

  const out: RoadWay[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const cls = classifyHighway(el.tags ?? {});
    if (!cls) continue;
    const points: LonLat[] = [];
    for (const g of el.geometry) {
      if (!Number.isFinite(g.lon) || !Number.isFinite(g.lat)) continue;
      if (g.lon < -180 || g.lon > 180 || g.lat < -90 || g.lat > 90) continue;
      const p: LonLat = [g.lon, g.lat];
      const last = points[points.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) {
        points.push(p);
      }
    }
    if (points.length < 2) continue;
    out.push({
      id: `way/${el.id}`,
      osmId: el.id,
      kind: cls.kind,
      name: el.tags?.name,
      widthM: cls.widthM,
      points,
    });
  }
  return out;
}

export function roadsQuery(lon: number, lat: number, radiusM: number): string {
  return (
    `[out:json][timeout:25];` +
    `way["highway"](around:${Math.round(radiusM)},${lat.toFixed(7)},${lon.toFixed(7)});` +
    `out geom;`
  );
}

// ---- local geometry (pure; unit-tested) ------------------------------------------

/** (lon, lat) -> local tangent-plane metres (x east, y north) about an origin. */
export function lonLatToLocal(p: LonLat, origin: LonLat): [number, number] {
  return [
    (p[0] - origin[0]) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(origin[1] * DEG_TO_RAD),
    (p[1] - origin[1]) * DEG_TO_RAD * EARTH_RADIUS_M,
  ];
}

/** Insert interpolated points so no segment exceeds maxStepM metres. */
export function subdivideLonLat(
  points: readonly LonLat[],
  maxStepM: number,
  origin: LonLat = points[0],
): LonLat[] {
  if (points.length < 2) return [...points];
  const out: LonLat[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const [ax, ay] = lonLatToLocal(a, origin);
    const [bx, by] = lonLatToLocal(b, origin);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxStepM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export interface RibbonGeometry {
  /** Flat xyz triples, two vertices (left, right) per centreline point. */
  positions: Float64Array;
  indices: Uint32Array;
}

/**
 * Build a flat ribbon around an xyz centreline: at each point the
 * direction is averaged from its neighbours, the normal is horizontal,
 * and both edge vertices share the point's z. Winding is CCW seen
 * from +z, so faces point up.
 */
export function ribbonFromPoints(
  points: ReadonlyArray<readonly [number, number, number]>,
  widthM: number,
): RibbonGeometry | null {
  const pts: Array<readonly [number, number, number]> = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) pts.push(p);
  }
  if (pts.length < 2 || !(widthM > 0)) return null;

  const half = widthM / 2;
  const positions = new Float64Array(pts.length * 2 * 3);
  const indices = new Uint32Array((pts.length - 1) * 6);

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const nx = -dy;
    const ny = dx;
    const [x, y, z] = pts[i];
    positions.set(
      [x + nx * half, y + ny * half, z, x - nx * half, y - ny * half, z],
      i * 6,
    );
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = 2 * i;
    const b = 2 * i + 1;
    const c = 2 * i + 2;
    const d = 2 * i + 3;
    indices.set([a, b, c, c, b, d], i * 6);
  }
  return { positions, indices };
}

// ---- loader (Cesium + network; mirrors buildings/streetObjects) -------------------

let activeViewer: Viewer | null = null;
let activePrimitive: Primitive | null = null;
let activeWays: RoadWay[] = [];
let generation = 0;
let pending: AbortController | null = null;
let lastCenter: { lon: number; lat: number; radiusM: number } | null = null;

export function getRoadWays(): readonly RoadWay[] {
  return activeWays;
}

/** Remove the roads primitive and cancel any in-flight load. */
export function clearRoads(): void {
  ++generation;
  pending?.abort();
  pending = null;
  if (activeViewer && activePrimitive) {
    activeViewer.scene.primitives.remove(activePrimitive);
  }
  activeViewer = null;
  activePrimitive = null;
  activeWays = [];
  lastCenter = null;
}

export interface LoadRoadsOptions {
  radiusM?: number;
  overpass?: OverpassFetchOptions;
}

/**
 * Load roads + sidewalks around (lon, lat). Call on camera settle or
 * from attachRoadsAutoLoad, not every frame. The previous set stays
 * visible until the new one is built. A reload centred within
 * RELOAD_WITHIN_M of the last successful one is a no-op. Returns the
 * number of ways drawn.
 */
export async function loadRoadsAround(
  viewer: Viewer,
  lon: number,
  lat: number,
  opts: LoadRoadsOptions = {},
): Promise<number> {
  const radiusM = Math.max(25, Math.min(800, opts.radiusM ?? DEFAULT_RADIUS_M));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new RangeError('Invalid roads area');
  }
  if (lastCenter && lastCenter.radiusM === radiusM) {
    const [dx, dy] = lonLatToLocal([lon, lat], [lastCenter.lon, lastCenter.lat]);
    if (Math.hypot(dx, dy) < RELOAD_WITHIN_M) return activeWays.length;
  }

  const gen = ++generation;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const stale = (): boolean => gen !== generation;

  const data = await fetchOverpassWithFallback(roadsQuery(lon, lat, radiusM), {
    ...opts.overpass,
    signal: controller.signal,
  });
  if (stale()) return 0;

  const ways = parseOverpassRoads(data).slice(0, MAX_ROADS);
  const origin: LonLat = [lon, lat];

  let originGround = tryHeightAt(lon, lat);
  if (originGround === undefined) originGround = await heightAt(lon, lat);
  if (stale()) return 0;

  const enu = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(lon, lat, originGround),
  );
  const up = Matrix3.multiplyByVector(
    Matrix4.getMatrix3(enu, new Matrix3()),
    new Cartesian3(0, 0, 1),
    new Cartesian3(),
  );

  const instances: GeometryInstance[] = [];
  const rendered: RoadWay[] = [];
  const scratch = new Cartesian3();

  for (const way of ways) {
    if (stale()) return 0;
    const subdiv = subdivideLonLat(way.points, SUBDIVIDE_M, origin);
    const xyz: Array<readonly [number, number, number]> = [];
    let ok = true;
    for (const p of subdiv) {
      let g = tryHeightAt(p[0], p[1]);
      if (g === undefined) {
        try {
          g = await heightAt(p[0], p[1]);
        } catch {
          ok = false;
          break;
        }
      }
      if (stale()) return 0;
      const [x, y] = lonLatToLocal(p, origin);
      xyz.push([x, y, g - originGround + ROAD_LIFTS_M[way.kind]]);
    }
    if (!ok) continue;

    const ribbon = ribbonFromPoints(xyz, way.widthM);
    if (!ribbon) continue;

    const world = new Float64Array(ribbon.positions.length);
    for (let i = 0; i < ribbon.positions.length; i += 3) {
      Cartesian3.fromElements(
        ribbon.positions[i],
        ribbon.positions[i + 1],
        ribbon.positions[i + 2],
        scratch,
      );
      Matrix4.multiplyByPoint(enu, scratch, scratch);
      world[i] = scratch.x;
      world[i + 1] = scratch.y;
      world[i + 2] = scratch.z;
    }
    const normals = new Float64Array(world.length);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i] = up.x;
      normals[i + 1] = up.y;
      normals[i + 2] = up.z;
    }

    // Cesium 1.140 typings: GeometryAttributes has a no-arg
    // constructor; attributes are assigned as properties.
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: world,
    });
    attributes.normal = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: normals,
    });
    const geometry = new Geometry({
      attributes,
      indices: ribbon.indices,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(world),
    });
    instances.push(
      new GeometryInstance({
        geometry,
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(
            Color.fromCssColorString(ROAD_COLORS[way.kind]),
          ),
        },
      }),
    );
    rendered.push(way);
  }

  if (stale()) return 0;

  if (activePrimitive && activeViewer) {
    activeViewer.scene.primitives.remove(activePrimitive);
    activePrimitive = null;
  }
  activeViewer = viewer;
  if (instances.length > 0) {
    activePrimitive = viewer.scene.primitives.add(
      new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({
          flat: true,
          renderState: {
            polygonOffset: { enabled: true, factor: -2, units: -2 },
          },
        }),
        asynchronous: false,
      }),
    );
  }
  activeWays = rendered;
  lastCenter = { lon, lat, radiusM };
  return rendered.length;
}

/**
 * Keep roads loaded while the camera moves: every intervalMs, if the
 * camera is near the ground and has moved at least RELOAD_WITHIN_M
 * from the last attempted centre, (re)load; above ROADS_MAX_HEIGHT_M
 * over the ground, clear instead. Returns a detach function.
 */
export function attachRoadsAutoLoad(viewer: Viewer, intervalMs = 500): () => void {
  let lastCheck = 0;
  let lastAttempt: LonLat | null = null;
  const off = viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (now - lastCheck < intervalMs) return;
    lastCheck = now;

    const c = viewer.camera.positionCartographic;
    const ground = viewer.scene.globe.getHeight(c) ?? 0;
    if (c.height - ground > ROADS_MAX_HEIGHT_M) {
      if (activePrimitive) clearRoads();
      lastAttempt = null;
      return;
    }
    const lon = CesiumMath.toDegrees(c.longitude);
    const lat = CesiumMath.toDegrees(c.latitude);
    if (lastAttempt) {
      const [dx, dy] = lonLatToLocal([lon, lat], lastAttempt);
      if (Math.hypot(dx, dy) < RELOAD_WITHIN_M) return;
    }
    lastAttempt = [lon, lat];
    loadRoadsAround(viewer, lon, lat).catch((err: unknown) => {
      lastAttempt = null; // let the next check retry
      console.warn('OSM roads unavailable:', err);
    });
  });
  return off;
}
