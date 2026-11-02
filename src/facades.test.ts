
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  MAX_DECORATED_BUILDINGS,
  MAX_FACADE_QUADS,
  buildFacadeWallMesh,
  clearBuildingFacades,
  drawFacadeTexture,
  facadeUvRect,
  nearestBuildings,
  styleForBuilding,
} from './facades';

import type { BuildingFootprint } from './buildings';

function building(
  id: string,
  lon: number,
  lat: number,
  heightM = 12,
): BuildingFootprint {
  const ring = [
    [lon, lat],
    [lon + 0.00004, lat],
    [lon + 0.00004, lat + 0.00004],
    [lon, lat + 0.00004],
  ] as [number, number][];

  return {
    id,
    name: id,
    ring,
    heightM,
    minHeightM: 0,
    center: [lon + 0.00002, lat + 0.00002],
    bounds: {
      west: lon,
      south: lat,
      east: lon + 0.00004,
      north: lat + 0.00004,
    },
  };
}

afterEach(() => {
  clearBuildingFacades();
});

describe('facade styling', () => {
  it('assigns a stable palette', () => {
    expect(
      styleForBuilding('osm:way:100', 12),
    ).toEqual(
      styleForBuilding('osm:way:100', 12),
    );
  });

  it('scales window-row counts with building height', () => {
    expect(styleForBuilding('building:1', 6).rows).toBe(2);
    expect(styleForBuilding('building:1', 30).rows).toBe(8);
  });

  it('provides valid facade and roof colors', () => {
    const style = styleForBuilding('ofm:14/1/2:3:0', 15);

    expect(style.wall).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.window).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.frame).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.roof).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('keeps the nearest-building budget', () => {
    const buildings = Array.from(
      { length: MAX_DECORATED_BUILDINGS + 50 },
      (_, i) =>
        building(`osm:way:${i}`, -73.8 + i * 0.0001, 40.7),
    );

    expect(
      nearestBuildings(buildings, -73.8, 40.7),
    ).toHaveLength(MAX_DECORATED_BUILDINGS);
  });

  it('selects nearer buildings first', () => {
    const far = building('far', -73.81, 40.71);
    const near = building('near', -73.80001, 40.70001);

    expect(
      nearestBuildings([far, near], -73.8, 40.7, 1)
        .map((f) => f.id),
    ).toEqual(['near']);
  });

  it('handles empty input', () => {
    expect(nearestBuildings([], -73.8, 40.7)).toEqual([]);
  });

  it('draws actual window pixels on a canvas context', () => {
    const ctx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
    };

    drawFacadeTexture(
      ctx as unknown as CanvasRenderingContext2D,
      styleForBuilding('osm:way:123', 12),
      256,
    );

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 256, 256);
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(20);
  });
});

describe('UV-mapped batched walls', () => {
  it('generates vertices, normals, UVs and triangles', () => {
    const footprint = building('osm:way:200', -73.8, 40.7);

    const mesh = buildFacadeWallMesh([
      { footprint, bottomM: 20, topM: 32 },
    ]);

    expect(mesh.quadCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.quadCount * 12);
    expect(mesh.normals.length).toBe(mesh.quadCount * 12);
    expect(mesh.st.length).toBe(mesh.quadCount * 8);
    expect(mesh.indices.length).toBe(mesh.quadCount * 6);
    expect(mesh.buildingIds).toEqual(['osm:way:200']);
  });

  it('gives each window bay its own UV rectangle', () => {
    const id = 'osm:way:201';
    const footprint = building(id, -73.8, 40.7);
    const mesh = buildFacadeWallMesh([
      { footprint, bottomM: 20, topM: 32 },
    ]);

    const uv = facadeUvRect(id);

    for (let i = 0; i < mesh.st.length; i += 8) {
      expect(mesh.st[i]).toBeCloseTo(uv.u0, 5);
      expect(mesh.st[i + 1]).toBeCloseTo(uv.v0, 5);
      expect(mesh.st[i + 2]).toBeCloseTo(uv.u1, 5);
      expect(mesh.st[i + 5]).toBeCloseTo(uv.v1, 5);
    }
  });

  it('keeps each UV rectangle inside its own atlas tile', () => {
    for (let i = 0; i < 60; i++) {
      const uv = facadeUvRect(`osm:way:${i}`);

      expect(uv.u0).toBeGreaterThanOrEqual(0);
      expect(uv.v0).toBeGreaterThanOrEqual(0);
      expect(uv.u1).toBeLessThanOrEqual(1);
      expect(uv.v1).toBeLessThanOrEqual(1);
      expect(uv.u1).toBeGreaterThan(uv.u0);
      expect(uv.v1).toBeGreaterThan(uv.v0);
    }
  });

  it('supports clockwise and counterclockwise footprints', () => {
    const ccw = building('a', -73.8, 40.7);
    const cw = building('b', -73.8, 40.7);
    cw.ring.reverse();

    const a = buildFacadeWallMesh([
      { footprint: ccw, bottomM: 0, topM: 12 },
    ]);
    const b = buildFacadeWallMesh([
      { footprint: cw, bottomM: 0, topM: 12 },
    ]);

    expect(a.quadCount).toBeGreaterThan(0);
    expect(b.quadCount).toBe(a.quadCount);
    expect(a.indices[1]).toBe(1);
    expect(b.indices[1]).toBe(2);
  });

  it('rejects invalid height ranges', () => {
    const footprint = building('bad', -73.8, 40.7);

    const mesh = buildFacadeWallMesh([
      { footprint, bottomM: 30, topM: 20 },
    ]);

    expect(mesh.quadCount).toBe(0);
    expect(mesh.buildingIds).toEqual([]);
  });

  it('honors the maximum quad budget', () => {
    const sources = Array.from({ length: 100 }, (_, i) => ({
      footprint: building(
        `osm:way:${i}`,
        -73.8 + i * 0.0001,
        40.7,
        60,
      ),
      bottomM: 0,
      topM: 60,
    }));

    const mesh = buildFacadeWallMesh(sources, 100);

    expect(mesh.quadCount).toBe(100);
    expect(mesh.quadCount).toBeLessThan(MAX_FACADE_QUADS);
  });

  it('generates finite ECEF coordinates and normalized normals', () => {
    const footprint = building('osm:way:300', -73.8, 40.7);

    const mesh = buildFacadeWallMesh([
      { footprint, bottomM: 20, topM: 32 },
    ]);

    expect(
      Array.from(mesh.positions).every(Number.isFinite),
    ).toBe(true);

    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(
        mesh.normals[i],
        mesh.normals[i + 1],
        mesh.normals[i + 2],
      );

      expect(length).toBeCloseTo(1, 4);
    }
  });
});
