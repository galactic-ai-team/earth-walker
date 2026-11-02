// src/streetObjects.test.ts — trees and street furniture (owner: Claude). No network, no viewer.
import { describe, expect, it } from 'vitest';

import {
  FOREST_SPACING_M,
  SINK_M,
  classifyPoint,
  createObstacleIndex,
  fromLocal,
  isStreetObstacle,
  parseStreetFeatures,
  partsFor,
  planStreetObjects,
  pointInRing,
  pointsAlongLine,
  scatterInArea,
  seededRandom,
  streetObjectsQuery,
  toLocal,
  treeDims,
  type LonLat,
  type StreetFeatures,
  type StreetObject,
} from './streetObjects';

const LON0 = -73.9897;
const LAT0 = 40.7411;

/** A square ring of side `side` metres centred `dx, dy` metres from the origin. */
function square(side: number, dx = 0, dy = 0): LonLat[] {
  const h = side / 2;
  return [
    [dx - h, dy - h],
    [dx + h, dy - h],
    [dx + h, dy + h],
    [dx - h, dy + h],
  ].map(([x, y]) => fromLocal(x, y, LON0, LAT0) as LonLat);
}

function at(dx: number, dy: number): { lon: number; lat: number } {
  const [lon, lat] = fromLocal(dx, dy, LON0, LAT0);
  return { lon, lat };
}

describe('classifyPoint', () => {
  it('recognises the mapped objects we draw', () => {
    expect(classifyPoint({ natural: 'tree' })).toBe('tree');
    expect(classifyPoint({ natural: 'tree', leaf_type: 'needleleaved' })).toBe('conifer');
    expect(classifyPoint({ highway: 'street_lamp' })).toBe('lamp');
    expect(classifyPoint({ amenity: 'bench' })).toBe('bench');
    expect(classifyPoint({ emergency: 'fire_hydrant' })).toBe('hydrant');
    expect(classifyPoint({ barrier: 'bollard' })).toBe('bollard');
    expect(classifyPoint({ amenity: 'cafe' })).toBeNull();
  });
});

describe('parseStreetFeatures', () => {
  const closed = (ring: LonLat[]) => [...ring, ring[0]].map(([lon, lat]) => ({ lon, lat }));

  it('keeps drawable nodes, tree rows, closed tree areas and closed multipolygon outers', () => {
    const data = {
      elements: [
        { type: 'node', id: 1, lat: LAT0, lon: LON0, tags: { natural: 'tree' } },
        { type: 'node', id: 2, lat: LAT0, lon: LON0, tags: { shop: 'bakery' } },
        { type: 'node', id: 3, tags: { natural: 'tree' } }, // no coordinates
        { type: 'way', id: 10, tags: { natural: 'tree_row' }, geometry: [at(0, 0), at(30, 0)] },
        { type: 'way', id: 11, tags: { landuse: 'forest' }, geometry: closed(square(50)) },
        { type: 'way', id: 12, tags: { leisure: 'park' }, geometry: [at(0, 0), at(10, 0), at(10, 10), at(0, 10)] }, // open
        {
          type: 'relation',
          id: 20,
          tags: { natural: 'wood' },
          members: [
            { role: 'outer', geometry: closed(square(40, 100, 0)) },
            { role: 'inner', geometry: closed(square(10, 100, 0)) },
          ],
        },
      ],
    };
    const f = parseStreetFeatures(data);
    expect(f.points.map((p) => p.id)).toEqual(['node/1']);
    expect(f.lines.map((l) => l.id)).toEqual(['way/10']);
    expect(f.areas.map((a) => a.id)).toEqual(['way/11', 'relation/20#0']);
    expect(f.areas[0].ring.length).toBe(4); // closing point dropped
  });

  it('survives junk', () => {
    expect(parseStreetFeatures(null)).toEqual({ points: [], areas: [], lines: [] });
    expect(parseStreetFeatures({ elements: 'nope' })).toEqual({ points: [], areas: [], lines: [] });
  });
});

describe('seededRandom', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);

    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('treeDims', () => {
  it('uses OSM height, crown diameter and trunk circumference when tagged', () => {
    const d = treeDims({ height: '12 m', diameter_crown: '8', circumference: '1.2566' }, seededRandom(1), false);
    expect(d.height).toBe(12);
    expect(d.crown).toBe(4);
    expect(d.radius).toBeCloseTo(0.2, 3);
  });

  it('falls back to plausible seeded sizes', () => {
    for (let s = 0; s < 50; s++) {
      const d = treeDims({}, seededRandom(s), s % 2 === 0);
      expect(d.height).toBeGreaterThanOrEqual(6);
      expect(d.height).toBeLessThanOrEqual(18);
      expect(d.crown).toBeGreaterThan(0.5);
      expect(d.radius).toBeGreaterThan(0.1);
      expect(d.radius).toBeLessThan(0.4);
    }
  });

  it('ignores absurd tags', () => {
    const d = treeDims({ height: '900' }, seededRandom(3), false);
    expect(d.height).toBeLessThan(20);
  });
});

describe('scatterInArea', () => {
  it('fills a forest at roughly the configured density, only inside it', () => {
    const ring = square(100);
    const pts = scatterInArea(ring, FOREST_SPACING_M, seededRandom(7), LON0, LAT0, 350);
    const expected = (100 / FOREST_SPACING_M) ** 2;
    expect(pts.length).toBeGreaterThan(expected * 0.8);
    expect(pts.length).toBeLessThan(expected * 1.2);
    const local = ring.map(([lon, lat]) => toLocal(lon, lat, LON0, LAT0));
    for (const [lon, lat] of pts) {
      const [x, y] = toLocal(lon, lat, LON0, LAT0);
      expect(pointInRing(x, y, local)).toBe(true);
    }
  });

  it('is clipped to the load circle and deterministic', () => {
    const ring = square(2000);
    const a = scatterInArea(ring, 20, seededRandom(9), LON0, LAT0, 100);
    const b = scatterInArea(ring, 20, seededRandom(9), LON0, LAT0, 100);
    expect(a).toEqual(b);
    for (const [lon, lat] of a) {
      const [x, y] = toLocal(lon, lat, LON0, LAT0);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(100);
    }
    expect(scatterInArea(square(50, 1000, 0), 7, seededRandom(1), LON0, LAT0, 350)).toEqual([]);
  });
});

describe('pointsAlongLine', () => {
  it('spaces points evenly, continuing across vertices', () => {
    const line: LonLat[] = [at(0, 0), at(20, 0), at(20, 20)].map((p) => [p.lon, p.lat]);
    const pts = pointsAlongLine(line, 8, LON0, LAT0).map(([lon, lat]) => toLocal(lon, lat, LON0, LAT0));
    expect(pts.length).toBe(6); // at 0, 8, 16, 24, 32, 40 m
    expect(pts[2][0]).toBeCloseTo(16, 6);

    expect(pts[3][0]).toBeCloseTo(20, 6);
    expect(pts[3][1]).toBeCloseTo(4, 6); // 24 m = 20 east + 4 north
  });
});

describe('planStreetObjects', () => {
  function features(): StreetFeatures {
    return {
      points: [
        { id: 'node/far', ...at(300, 0), tags: { natural: 'tree' } },
        { id: 'node/near', ...at(5, 0), tags: { highway: 'street_lamp' } },
        { id: 'node/out', ...at(900, 0), tags: { natural: 'tree' } },
      ],
      lines: [],
      areas: [{ id: 'way/forest', ring: square(60, 0, 50), tags: { landuse: 'forest' } }],
    };
  }

  it('puts mapped objects first (nearest first), drops anything outside the radius', () => {
    const objs = planStreetObjects(features(), LON0, LAT0, 350);
    expect(objs[0].id).toBe('node/near');
    expect(objs[1].id).toBe('node/far');
    expect(objs.find((o) => o.id === 'node/out')).toBeUndefined();
    expect(objs.slice(2).every((o) => !o.mapped && (o.kind === 'tree' || o.kind === 'conifer'))).toBe(true);
  });

  it('caps the total and honours exclude for scattered trees', () => {
    expect(planStreetObjects(features(), LON0, LAT0, 350, { maxObjects: 5 })).toHaveLength(5);
    const none = planStreetObjects(features(), LON0, LAT0, 350, { exclude: () => true });
    expect(none.every((o) => o.mapped)).toBe(true);
  });

  it('gives the same result every time (stable look across reloads)', () => {
    expect(planStreetObjects(features(), LON0, LAT0, 350)).toEqual(planStreetObjects(features(), LON0, LAT0, 350));
  });
});

describe('partsFor', () => {
  const base: StreetObject = { id: 'x', kind: 'tree', lon: 0, lat: 0, height: 10, radius: 0.2, crown: 3, yaw: 0, tint: 0.5, mapped: true };
  const bottom = (p: { center: number[]; size: number[] }) => p.center[2] - p.size[2] / 2;
  const top = (p: { center: number[]; size: number[] }) => p.center[2] + p.size[2] / 2;

  it('builds a tree whose trunk sinks below ground and whose crown tops out at its height', () => {
    const [trunk, crown] = partsFor(base);
    expect(trunk.shape).toBe('cylinder');
    expect(bottom(trunk)).toBeCloseTo(-SINK_M, 9);
    expect(crown.shape).toBe('ball');
    expect(top(crown)).toBeCloseTo(10, 9);
  });

  it('builds conifers, lamps, benches, hydrants and bollards with sensible parts', () => {
    const conifer = partsFor({ ...base, kind: 'conifer' });
    expect(conifer.map((p) => p.shape)).toEqual(['cylinder', 'cone']);
    expect(top(conifer[1])).toBeCloseTo(10, 9);
    const lamp = partsFor({ ...base, kind: 'lamp', height: 6 });
    expect(top(lamp[0])).toBeCloseTo(6, 9);
    for (const kind of ['bench', 'hydrant', 'bollard'] as const) {
      const parts = partsFor({ ...base, kind, height: 0.9 });
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((p) => p.size.every((v) => v > 0))).toBe(true);
    }
  });
});

describe('createObstacleIndex', () => {
  const obj = (dx: number, dy: number, radius: number): StreetObject => ({
    id: `o${dx},${dy}`, kind: 'tree', ...at(dx, dy), height: 8, radius, crown: 2, yaw: 0, tint: 0, mapped: true,
  });

  it('blocks within trunk radius plus clearance, and only there', () => {
    const idx = createObstacleIndex([obj(10, 10, 0.3)], LON0, LAT0);
    const p = (dx: number, dy: number) => { const q = at(dx, dy); return idx.isBlocked(q.lon, q.lat, 0.4); };
    expect(p(10, 10)).toBe(true);
    expect(p(10.6, 10)).toBe(true); // 0.6 < 0.7
    expect(p(10.8, 10)).toBe(false); // 0.8 > 0.7
    expect(p(100, 100)).toBe(false);
    expect(idx.isBlocked(Number.NaN, 0)).toBe(false);
  });

  it('finds obstacles across grid-cell boundaries', () => {
    const idx = createObstacleIndex([obj(7.9, 0, 0.3)], LON0, LAT0);
    const q = at(8.3, 0);
    expect(idx.isBlocked(q.lon, q.lat, 0.4)).toBe(true);
  });

  it('nothing is blocked before anything has loaded', () => {
    expect(isStreetObstacle(LON0, LAT0)).toBe(false);
  });
});

describe('streetObjectsQuery', () => {
  it('asks Overpass for every kind we draw around the point', () => {
    const q = streetObjectsQuery(7.7848, 45.9837, 350);
    for (const tag of ['"natural"="tree"', 'street_lamp', 'bench', 'fire_hydrant', 'bollard', 'tree_row', 'forest', 'wood', 'park']) {
      expect(q).toContain(tag);
    }

    expect(q).toContain('(around:350,45.9837000,7.7848000)');
    expect(q.endsWith('out geom;')).toBe(true);
  });
});
