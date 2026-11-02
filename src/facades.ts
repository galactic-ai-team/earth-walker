/**
 * Earth Walker — procedural building facades
 * GPT-6 / Buildings lane
 *
 * Decorates nearby Cesium building entities with shared,
 * procedurally drawn facade textures and flat roof caps.
 *
 * No network requests, Cesium ion, or extra dependencies.
 * Does not modify building geometry or collision footprints.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  ImageMaterialProperty,
  PolygonHierarchy,
  type Entity,
  type MaterialProperty,
  type Viewer,
} from 'cesium';

import {
  getBuildingFootprints,
  type BuildingFootprint,
  type LonLat,
} from './buildings';

export const MAX_DECORATED_BUILDINGS = 120;
export const ROOF_CAP_OFFSET_M = 0.08;

export interface FacadeStyle {
  wall: string;
  window: string;
  frame: string;
  roof: string;
  columns: number;
  rows: number;
}

const PALETTES = [
  {
    wall: '#b97864',
    window: '#314756',
    frame: '#e0c5ae',
    roof: '#655750',
  },
  {
    wall: '#d2bfa4',
    window: '#425866',
    frame: '#eee4d4',
    roof: '#77736d',
  },
  {
    wall: '#929aa1',
    window: '#304757',
    frame: '#c7ced1',
    roof: '#555e66',
  },
  {
    wall: '#717f8b',
    window: '#86a7b7',
    frame: '#b6c4cb',
    roof: '#424d59',
  },
  {
    wall: '#c0aaa0',
    window: '#394f5c',
    frame: '#e2d4c9',
    roof: '#756b64',
  },
  {
    wall: '#c9b8a3',
    window: '#526b76',
    frame: '#e5dbcb',
    roof: '#736d65',
  },
] as const;

interface Decoration {
  building: Entity;
  originalMaterial: MaterialProperty | undefined;
  roof: Entity;
}

let decoratedViewer: Viewer | null = null;
const decorations: Decoration[] = [];
const materialCache = new Map<number, ImageMaterialProperty>();

function hashString(value: string): number {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/** Pure, deterministic building appearance. */
export function styleForBuilding(
  id: string,
  heightM: number,
): FacadeStyle {
  const hash = hashString(id);
  const palette = PALETTES[hash % PALETTES.length];

  return {
    ...palette,
    columns: 4,
    rows: Math.max(
      2,
      Math.min(8, Math.round(heightM / 3)),
    ),
  };
}

/**
 * Rank buildings by approximate ground distance.
 * Stable sorting makes the decoration budget predictable.
 */
export function nearestBuildings(
  footprints: readonly BuildingFootprint[],
  lon: number,
  lat: number,
  limit = MAX_DECORATED_BUILDINGS,
): BuildingFootprint[] {
  const radians = Math.PI / 180;
  const metresLat = 111_320;
  const metresLon =
    metresLat * Math.max(0.01, Math.cos(lat * radians));

  return footprints
    .map((building) => {
      const dx = (building.center[0] - lon) * metresLon;
      const dy = (building.center[1] - lat) * metresLat;

      return {
        building,
        distanceSquared: dx * dx + dy * dy,
      };
    })
    .sort(
      (a, b) =>
        a.distanceSquared - b.distanceSquared ||
        a.building.id.localeCompare(b.building.id),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ building }) => building);
}

/**
 * Generate one square facade texture.
 * Windows are drawn as part of the texture, not entities.
 */
export function drawFacadeTexture(
  context: CanvasRenderingContext2D,
  style: FacadeStyle,
  size = 256,
): void {
  const ctx = context;
  const columns = Math.max(1, Math.floor(style.columns));
  const rows = Math.max(1, Math.floor(style.rows));

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = style.wall;
  ctx.fillRect(0, 0, size, size);

  const columnWidth = size / columns;
  const rowHeight = size / rows;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = col * columnWidth + columnWidth * 0.22;
      const y = row * rowHeight + rowHeight * 0.17;
      const width = columnWidth * 0.56;
      const height = rowHeight * 0.62;

      ctx.fillStyle = style.frame;
      ctx.fillRect(
        x - 2,
        y - 2,
        width + 4,
        height + 4,
      );

      ctx.fillStyle = style.window;
      ctx.fillRect(x, y, width, height);

      // Subtle reflected sky.
      ctx.fillStyle = 'rgba(220,235,245,0.20)';
      ctx.fillRect(
        x + width * 0.08,
        y + height * 0.05,
        width * 0.25,
        height * 0.75,
      );

      // Central mullion.
      ctx.fillStyle = style.frame;
      ctx.fillRect(
        x + width * 0.49,
        y,
        Math.max(1, width * 0.035),
        height,
      );
    }
  }

  // Ground-floor band.
  ctx.fillStyle = 'rgba(25,30,38,0.14)';
  ctx.fillRect(0, size * 0.91, size, size * 0.09);
}

function materialForStyle(
  paletteIndex: number,
): ImageMaterialProperty {
  const cached = materialCache.get(paletteIndex);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Facade texture requires Canvas 2D');
  }

  const palette = PALETTES[paletteIndex];

  drawFacadeTexture(ctx, {
    ...palette,
    columns: 4,
    rows: 5,
  });

  const material = new ImageMaterialProperty({
    image: canvas,
    transparent: false,
    repeat: new Cartesian2(1, 1),
  });

  materialCache.set(paletteIndex, material);
  return material;
}

function paletteIndexFor(id: string): number {
  return hashString(id) % PALETTES.length;
}

/** Building entity ids are stored in Cesium's property bag. */
function entityBuildingId(
  entity: Entity,
  viewer: Viewer,
): string | null {
  const value = entity.properties?.osmId?.getValue(
    viewer.clock.currentTime,
  );

  return typeof value === 'string' ? value : null;
}

function roofHierarchy(
  ring: readonly LonLat[],
): PolygonHierarchy {
  const degrees: number[] = [];

  for (const [lon, lat] of ring) {
    degrees.push(lon, lat);
  }

  return new PolygonHierarchy(
    Cartesian3.fromDegreesArray(degrees),
  );
}

/** Remove roof caps and restore existing building materials. */
export function clearBuildingFacades(): void {
  if (decoratedViewer) {
    for (const decoration of decorations) {
      const polygon = decoration.building.polygon;

      if (polygon && decoration.originalMaterial) {
        polygon.material = decoration.originalMaterial;
      }

      decoratedViewer.entities.remove(decoration.roof);
    }
  }

  decorations.length = 0;
  decoratedViewer = null;
}

/**
 * Decorate only the nearest existing buildings.
 *
 * Call after loadBuildingsAround() finishes.
 * Repeated calls remove the previous decorative roof caps.
 * The underlying OSM building entities remain untouched
 * except for their visual material.
 */
export function syncBuildingFacades(
  viewer: Viewer,
  lon: number,
  lat: number,
  limit = MAX_DECORATED_BUILDINGS,
): number {
  clearBuildingFacades();

  const footprints = nearestBuildings(
    getBuildingFootprints(),
    lon,
    lat,
    limit,
  );

  if (footprints.length === 0) return 0;

  const byId = new Map<string, Entity>();

  for (const entity of viewer.entities.values) {
    const id = entityBuildingId(entity, viewer);
    if (id) byId.set(id, entity);
  }

  decoratedViewer = viewer;

  for (const footprint of footprints) {
    const building = byId.get(footprint.id);
    const polygon = building?.polygon;

    if (!building || !polygon) continue;

    const height = polygon.height?.getValue(
      viewer.clock.currentTime,
    );

    if (
      typeof height !== 'number' ||
      !Number.isFinite(height)
    ) {
      continue;
    }

    const paletteIndex = paletteIndexFor(footprint.id);
    const style = styleForBuilding(
      footprint.id,
      footprint.heightM,
    );

    const originalMaterial = polygon.material;

    polygon.material = materialForStyle(paletteIndex);

    // A separate flat cap hides facade UVs on the rooftop.
    // It also gives buildings distinct roof colors.
    const roof = viewer.entities.add({
      name: `${footprint.name} roof`,
      polygon: {
        hierarchy: roofHierarchy(footprint.ring),
        height: height + ROOF_CAP_OFFSET_M,
        material: Color.fromCssColorString(style.roof),
        outline: false,
        perPositionHeight: false,
      },
    });

    decorations.push({
      building,
      originalMaterial,
      roof,
    });
  }

  return decorations.length;
}
