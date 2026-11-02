import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  MAX_DECORATED_BUILDINGS,
  clearBuildingFacades,
  drawFacadeTexture,
  nearestBuildings,
  styleForBuilding,
} from './facades';

import type { BuildingFootprint } from './buildings';

function building(
  id: string,
  lon: number,
  lat: number,
): BuildingFootprint {
  const ring = [
    [lon, lat],
    [lon + 0.00001, lat],
    [lon + 0.00001, lat + 0.00001],
    [lon, lat + 0.00001],
  ] as [number, number][];

  return {
    id,
    name: id,
    ring,
    heightM: 12,
    minHeightM: 0,
    center: [lon + 0.000005, lat + 0.000005],
    bounds: {
      west: lon,
      south: lat,
      east: lon + 0.00001,
      north: lat + 0.00001,
    },
  };
}

afterEach(() => {
  clearBuildingFacades();
});

describe('facade styling', () => {
  it('assigns a stable palette to the same building', () => {
    expect(
      styleForBuilding('osm:way:100', 12),
    ).toEqual(
      styleForBuilding('osm:way:100', 12),
    );
  });

  it('scales the window-row count with building height', () => {
    const small = styleForBuilding('building:1', 6);
    const tall = styleForBuilding('building:1', 30);

    expect(small.rows).toBe(2);
    expect(tall.rows).toBe(8);
    expect(small.columns).toBe(4);
  });

  it('produces valid facade and roof colors', () => {
    const style = styleForBuilding('ofm:14/1/2:3:0', 15);

    expect(style.wall).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.window).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.frame).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.roof).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('caps the number of decorated buildings', () => {
    const buildings = Array.from(
      { length: MAX_DECORATED_BUILDINGS + 50 },
      (_, i) => building(
        `osm:way:${i}`,
        -73.8 + i * 0.00001,
        40.7,
      ),
    );

    const selected = nearestBuildings(
      buildings,
      -73.8,
      40.7,
    );

    expect(selected).toHaveLength(MAX_DECORATED_BUILDINGS);
  });

  it('selects nearer buildings first', () => {
    const far = building('far', -73.81, 40.71);
    const near = building('near', -73.80001, 40.70001);

    const selected = nearestBuildings(
      [far, near],
      -73.8,
      40.7,
      1,
    );

    expect(selected.map((item) => item.id)).toEqual([
      'near',
    ]);
  });

  it('handles an empty footprint collection', () => {
    expect(
      nearestBuildings([], -73.8, 40.7),
    ).toEqual([]);
  });

  it('draws windows into one canvas texture', () => {
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

    expect(ctx.clearRect).toHaveBeenCalledWith(
      0, 0, 256, 256,
    );

    // Base wall, window frames, windows, reflections,
    // mullions, and ground-floor band.
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(20);
  });
});
