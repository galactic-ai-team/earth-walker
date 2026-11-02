/**
 * Earth Walker — batched, UV-mapped building facades
 * GPT-6 / Buildings lane
 *
 * One Cesium primitive for nearby building walls, using a
 * six-style procedural texture atlas. Original OSM footprints
 * remain the authority for collision.
 *
 * No API keys, external imagery, or additional dependencies.
 */

import {
  BoundingSphere,
  Cartesian3,
  Color,
  ComponentDatatype,
  ConstantProperty,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  Material,
  MaterialAppearance,
  PolygonHierarchy,
  Primitive,
  PrimitiveType,
  type Entity,
  type Property,
  type Viewer,
} from 'cesium';

import {
  getBuildingFootprints,
  type BuildingFootprint,
  type LonLat,
} from './buildings';

export const MAX_DECORATED_BUILDINGS = 120;
export const MAX_FACADE_QUADS = 16000;
export const ROOF_CAP_OFFSET_M = 0.08;

const ATLAS_COLUMNS = 3;
const ATLAS_ROWS = 2;
const TILE_SIZE = 256;
const WINDOW_BAY_M = 3;
const FLOOR_HEIGHT_M = 3;
const MAX_BAYS_PER_EDGE = 16;
const MAX_FLOORS = 24;
const UV_INSET = 1.5 / TILE_SIZE;

export interface FacadeStyle {
  wall: string;
  window: string;
  frame: string;
  roof: string;
  columns: number;
  rows: number;
}

const PALETTES = [
  { wall: '#b97864', window: '#314756', frame: '#e0c5ae', roof: '#655750' },
  { wall: '#d2bfa4', window: '#425866', frame: '#eee4d4', roof: '#77736d' },
  { wall: '#929aa1', window: '#304757', frame: '#c7ced1', roof: '#555e66' },
  { wall: '#717f8b', window: '#86a7b7', frame: '#b6c4cb', roof: '#424d59' },
  { wall: '#c0aaa0', window: '#394f5c', frame: '#e2d4c9', roof: '#756b64' },
  { wall: '#c9b8a3', window: '#526b76', frame: '#e5dbcb', roof: '#736d65' },
] as const;

export interface WallSource {
  footprint: BuildingFootprint;
  /** Absolute elevation of the bottom of the building, metres. */
  bottomM: number;
  /** Absolute elevation of the top of the building, metres. */
  topM: number;
}

export interface WallMesh {
  positions: Float64Array;
  normals: Float32Array;
  st: Float32Array;
  indices: Uint32Array;
  quadCount: number;
  buildingIds: string[];
}

interface Decoration {
  building: Entity;
  originalShow: Property | undefined;
  roof: Entity;
}

const decorations: Decoration[] = [];
let decoratedViewer: Viewer | null = null;
let wallsPrimitive: Primitive | null = null;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function paletteIndex(id: string): number {
  return hashString(id) % PALETTES.length;
}

export function styleForBuilding(
  id: string,
  heightM: number,
): FacadeStyle {
  return {
    ...PALETTES[paletteIndex(id)],
    columns: 4,
    rows: Math.max(2, Math.min(8, Math.round(heightM / 3))),
  };
}

export function nearestBuildings(
  footprints: readonly BuildingFootprint[],
  lon: number,
  lat: number,
  limit = MAX_DECORATED_BUILDINGS,
): BuildingFootprint[] {
  const radians = Math.PI / 180;
  const metresLat = 111320;
  const metresLon =
    metresLat * Math.max(0.01, Math.cos(lat * radians));

  return footprints
    .map((building) => ({
      building,
      distanceSquared:
        ((building.center[0] - lon) * metresLon) ** 2 +
        ((building.center[1] - lat) * metresLat) ** 2,
    }))
    .sort(
      (a, b) =>
        a.distanceSquared - b.distanceSquared ||
        a.building.id.localeCompare(b.building.id),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ building }) => building);
}

/** A reusable square tile containing one window bay and floor. */
export function drawFacadeTexture(
  ctx: CanvasRenderingContext2D,
  style: FacadeStyle,
  size = TILE_SIZE,
): void {
  const columns = Math.max(1, Math.floor(style.columns));
  const rows = Math.max(1, Math.floor(style.rows));

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = style.wall;
  ctx.fillRect(0, 0, size, size);

  const cw = size / columns;
  const rh = size / rows;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = col * cw + cw * 0.22;
      const y = row * rh + rh * 0.17;
      const w = cw * 0.56;
      const h = rh * 0.62;

      ctx.fillStyle = style.frame;
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

      ctx.fillStyle = style.window;
      ctx.fillRect(x, y, w, h);

      ctx.fillStyle = 'rgba(220,235,245,0.20)';
      ctx.fillRect(x + w * 0.08, y + h * 0.05, w * 0.25, h * 0.75);

      ctx.fillStyle = style.frame;
      ctx.fillRect(x + w * 0.49, y, Math.max(1, w * 0.035), h);
    }
  }

  ctx.fillStyle = 'rgba(25,30,38,0.14)';
  ctx.fillRect(0, size * 0.91, size, size * 0.09);
}

/**
 * The full atlas uses one window per panel.
 * Explicit per-bay UVs create repetition on each wall.
 */
function createAtlas(): HTMLCanvasElement {
  const atlas = document.createElement('canvas');
  atlas.width = TILE_SIZE * ATLAS_COLUMNS;
  atlas.height = TILE_SIZE * ATLAS_ROWS;

  const context = atlas.getContext('2d');
  if (!context) throw new Error('Facade atlas needs Canvas 2D');

  for (let i = 0; i < PALETTES.length; i++) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = TILE_SIZE;

    const ctx = tile.getContext('2d');
    if (!ctx) throw new Error('Facade tile needs Canvas 2D');

    drawFacadeTexture(ctx, {
      ...PALETTES[i],
      columns: 1,
      rows: 1,
    });

    context.drawImage(
      tile,
      (i % ATLAS_COLUMNS) * TILE_SIZE,
      Math.floor(i / ATLAS_COLUMNS) * TILE_SIZE,
    );
  }

  return atlas;
}

function signedArea(ring: readonly LonLat[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

/** Return the atlas UV rectangle for one building style. */
export function facadeUvRect(id: string): {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
} {
  const index = paletteIndex(id);
  const col = index % ATLAS_COLUMNS;
  const row = Math.floor(index / ATLAS_COLUMNS);

  return {
    u0: (col + UV_INSET) / ATLAS_COLUMNS,
    u1: (col + 1 - UV_INSET) / ATLAS_COLUMNS,
    v0: 1 - (row + 1 - UV_INSET) / ATLAS_ROWS,
    v1: 1 - (row + UV_INSET) / ATLAS_ROWS,
  };
}

/**
 * Pure geometry construction; no viewer or DOM required.
 * Each wall is divided into window bays and floors.
 *
 * One quad = 4 vertices, 2 triangles.
 * ECEF positions are Float64 for globe-scale accuracy.
 */
export function buildFacadeWallMesh(
  sources: readonly WallSource[],
  maxQuads = MAX_FACADE_QUADS,
): WallMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const st: number[] = [];
  const indices: number[] = [];
  const buildingIds: string[] = [];

  const east = new Cartesian3();
  const vertical = new Cartesian3();
  const normal = new Cartesian3();

  let quadCount = 0;

  for (const source of sources) {
    if (quadCount >= maxQuads) break;

    const { footprint, bottomM, topM } = source;
    const ring = footprint.ring;

    if (
      ring.length < 3 ||
      !Number.isFinite(bottomM) ||
      !Number.isFinite(topM) ||
      topM <= bottomM
    ) continue;

    const winding = signedArea(ring) >= 0 ? 1 : -1;
    const uv = facadeUvRect(footprint.id);
    const floors = Math.max(
      1,
      Math.min(
        MAX_FLOORS,
        Math.round((topM - bottomM) / FLOOR_HEIGHT_M),
      ),
    );

    const quadsBefore = quadCount;

    for (let edge = 0; edge < ring.length; edge++) {
      if (quadCount >= maxQuads) break;

      const a = ring[edge];
      const b = ring[(edge + 1) % ring.length];

      const aGround = Cartesian3.fromDegrees(a[0], a[1], bottomM);
      const bGround = Cartesian3.fromDegrees(b[0], b[1], bottomM);
      const lengthM = Cartesian3.distance(aGround, bGround);

      if (lengthM < 0.2) continue;

      const bays = Math.max(
        1,
        Math.min(MAX_BAYS_PER_EDGE, Math.round(lengthM / WINDOW_BAY_M)),
      );

      const aTop = Cartesian3.fromDegrees(a[0], a[1], topM);
      Cartesian3.subtract(bGround, aGround, east);
      Cartesian3.subtract(aTop, aGround, vertical);
      Cartesian3.cross(east, vertical, normal);

      if (Cartesian3.magnitudeSquared(normal) < 1e-10) continue;

      Cartesian3.normalize(normal, normal);
      if (winding < 0) Cartesian3.negate(normal, normal);

      for (let bay = 0; bay < bays; bay++) {
        if (quadCount >= maxQuads) break;

        const t0 = bay / bays;
        const t1 = (bay + 1) / bays;

        const lon0 = a[0] + (b[0] - a[0]) * t0;
        const lat0 = a[1] + (b[1] - a[1]) * t0;
        const lon1 = a[0] + (b[0] - a[0]) * t1;
        const lat1 = a[1] + (b[1] - a[1]) * t1;

        for (let floor = 0; floor < floors; floor++) {
          if (quadCount >= maxQuads) break;

          const h0 = bottomM + (topM - bottomM) * floor / floors;
          const h1 = bottomM + (topM - bottomM) * (floor + 1) / floors;

          const corners = [
            Cartesian3.fromDegrees(lon0, lat0, h0),
            Cartesian3.fromDegrees(lon1, lat1, h0),
            Cartesian3.fromDegrees(lon1, lat1, h1),
            Cartesian3.fromDegrees(lon0, lat0, h1),
          ];

          const first = positions.length / 3;

          for (const p of corners) {
            positions.push(p.x, p.y, p.z);
            normals.push(normal.x, normal.y, normal.z);
          }

          st.push(
            uv.u0, uv.v0,
            uv.u1, uv.v0,
            uv.u1, uv.v1,
            uv.u0, uv.v1,
          );

          if (winding > 0) {
            indices.push(
              first, first + 1, first + 2,
              first, first + 2, first + 3,
            );
          } else {
            indices.push(
              first, first + 2, first + 1,
              first, first + 3, first + 2,
            );
          }

          quadCount++;
        }
      }
    }

    if (quadCount > quadsBefore) buildingIds.push(footprint.id);
  }

  return {
    positions: new Float64Array(positions),
    normals: new Float32Array(normals),
    st: new Float32Array(st),
    indices: new Uint32Array(indices),
    quadCount,
    buildingIds,
  };
}

function entityBuildingId(
  entity: Entity,
  viewer: Viewer,
): string | null {
  const id = entity.properties?.osmId?.getValue(
    viewer.clock.currentTime,
  );
  return typeof id === 'string' ? id : null;
}

function roofHierarchy(ring: readonly LonLat[]): PolygonHierarchy {
  const degrees: number[] = [];
  for (const [lon, lat] of ring) degrees.push(lon, lat);
  return new PolygonHierarchy(Cartesian3.fromDegreesArray(degrees));
}

function makeWallsPrimitive(mesh: WallMesh): Primitive {
  // Cesium 1.140's GeometryAttributes constructor is zero-arg.
  // Attributes are assigned after construction.
  const attributes = new GeometryAttributes();

  attributes.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: mesh.positions,
  });

  attributes.normal = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: mesh.normals,
  });

  attributes.st = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: mesh.st,
  });

  const geometry = new Geometry({
    attributes,
    indices: mesh.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(mesh.positions),
  });

  const appearance = new MaterialAppearance({
    material: Material.fromType('Image', {
      image: createAtlas(),
    }),
    translucent: false,
    closed: false,
    faceForward: true,
    materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
  });

  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry }),
    appearance,
    asynchronous: false,
    allowPicking: false,
  });
}

/** Restore original entities and destroy the batched walls. */
export function clearBuildingFacades(): void {
  if (decoratedViewer) {
    for (const decoration of decorations) {
      const polygon = decoration.building.polygon;

      if (polygon) {
        polygon.show =
          decoration.originalShow ?? new ConstantProperty(true);
      }

      decoratedViewer.entities.remove(decoration.roof);
    }

    if (wallsPrimitive) {
      decoratedViewer.scene.primitives.remove(wallsPrimitive);
    }
  }

  wallsPrimitive = null;
  decorations.length = 0;
  decoratedViewer = null;
}

/**
 * Replace nearest building extrusions with UV-mapped walls.
 * Flat, solid-colour roof caps stay as individual entities.
 *
 * Existing main.ts calls this after loadBuildingsAround().
 */
export function syncBuildingFacades(
  viewer: Viewer,
  lon: number,
  lat: number,
  limit = MAX_DECORATED_BUILDINGS,
): number {
  clearBuildingFacades();

  const selected = nearestBuildings(
    getBuildingFootprints(),
    lon,
    lat,
    limit,
  );

  if (selected.length === 0) return 0;

  const byId = new Map<string, Entity>();

  for (const entity of viewer.entities.values) {
    const id = entityBuildingId(entity, viewer);
    if (id) byId.set(id, entity);
  }

  const sources: WallSource[] = [];
  const matches = new Map<string, {
    footprint: BuildingFootprint;
    entity: Entity;
    topM: number;
  }>();

  for (const footprint of selected) {
    const entity = byId.get(footprint.id);
    const polygon = entity?.polygon;
    if (!entity || !polygon) continue;

    const topM = polygon.height?.getValue(viewer.clock.currentTime);
    const bottomM = polygon.extrudedHeight?.getValue(
      viewer.clock.currentTime,
    );

    if (
      typeof topM !== 'number' ||
      typeof bottomM !== 'number' ||
      !Number.isFinite(topM) ||
      !Number.isFinite(bottomM) ||
      topM <= bottomM
    ) continue;

    sources.push({ footprint, bottomM, topM });
    matches.set(footprint.id, { footprint, entity, topM });
  }

  const mesh = buildFacadeWallMesh(sources);
  if (mesh.quadCount === 0) return 0;

  const primitive = makeWallsPrimitive(mesh);
  viewer.scene.primitives.add(primitive);

  decoratedViewer = viewer;
  wallsPrimitive = primitive;

  for (const id of mesh.buildingIds) {
    const match = matches.get(id);
    if (!match) continue;

    const { footprint, entity, topM } = match;
    const polygon = entity.polygon;
    if (!polygon) continue;

    // Cesium PolygonGraphics.show expects a Property,
    // not a plain boolean.
    const originalShow = polygon.show;
    polygon.show = new ConstantProperty(false);

    const style = styleForBuilding(
      footprint.id,
      footprint.heightM,
    );

    const roof = viewer.entities.add({
      name: `${footprint.name} roof`,
      polygon: {
        hierarchy: roofHierarchy(footprint.ring),
        height: topM + ROOF_CAP_OFFSET_M,
        material: Color.fromCssColorString(style.roof),
        outline: false,
        perPositionHeight: false,
      },
    });

    decorations.push({
      building: entity,
      originalShow,
      roof,
    });
  }

  return decorations.length;
}
