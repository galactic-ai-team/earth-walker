// src/roads.test.ts — lane 5 (street layer) tests: highway
// classification, Overpass parsing, and ribbon geometry.
// Pure: no network, no Cesium viewer.

import { describe, expect, it } from 'vitest';

import {
  classifyHighway,
  lonLatToLocal,
  parseOverpassRoads,
  ribbonFromPoints,
  roadsQuery,
  subdivideLonLat,
} from './roads';

describe('classifyHighway', () => {
  it('classifies roads with class-default widths', () => {
    expect(classifyHighway({ highway: 'residential' })).toEqual({ kind: 'road', widthM: 6.5 });
    expect(classifyHighway({ highway: 'trunk' })).toEqual({ kind: 'road', widthM: 10.5 });
    expect(classifyHighway({ highway: 'service' })).toEqual({ kind: 'road', widthM: 4 });
  });

  it('derives road width from lanes when no width tag', () => {
    expect(classifyHighway({ highway: 'primary', lanes: '3' })?.widthM).toBeCloseTo(10.2);
    expect(classifyHighway({ highway: 'primary', lanes: '1' })?.widthM).toBeCloseTo(3.4);
  });

  it('lets an explicit width tag win over lanes and defaults', () => {
    expect(classifyHighway({ highway: 'primary', lanes: '4', width: '5' })?.widthM).toBe(5);
    expect(classifyHighway({ highway: 'footway', width: '3' })?.widthM).toBe(3);
  });

  it('splits footways into sidewalk / crosswalk / path', () => {
    expect(classifyHighway({ highway: 'footway', footway: 'sidewalk' }))
      .toEqual({ kind: 'sidewalk', widthM: 1.8 });
    expect(classifyHighway({ highway: 'sidewalk' })?.kind).toBe('sidewalk');
    expect(classifyHighway({ highway: 'footway', footway: 'crossing' }))
      .toEqual({ kind: 'crosswalk', widthM: 2.5 });
    expect(classifyHighway({ highway: 'footway' })?.kind).toBe('path');
    expect(classifyHighway({ highway: 'cycleway' })).toEqual({ kind: 'path', widthM: 2.5 });
    expect(classifyHighway({ highway: 'steps' })?.kind).toBe('path');
  });

  it('rejects non-ribbon highways and areas', () => {
    expect(classifyHighway({ highway: 'bus_stop' })).toBeNull();
    expect(classifyHighway({ highway: 'platform' })).toBeNull();
    expect(classifyHighway({ highway: 'pedestrian', area: 'yes' })).toBeNull();
    expect(classifyHighway({})).toBeNull();
    expect(classifyHighway({ building: 'yes' })).toBeNull();
  });
});

describe('parseOverpassRoads', () => {
  const data = {
    elements: [
      { type: 'node', id: 1, lat: 40.74, lon: -73.98 },
      {
        type: 'way',
        id: 10,
        tags: { highway: 'residential', name: 'West 21st Street' },
        geometry: [
          { lon: -73.99, lat: 40.741 },
          { lon: -73.99, lat: 40.741 }, // duplicate point, dropped
          { lon: -73.988, lat: 40.741 },
        ],
      },
      {
        type: 'way',
        id: 11,
        tags: { highway: 'footway', footway: 'sidewalk' },
        geometry: [
          { lon: -73.99, lat: 40.742 },
          { lon: -73.988, lat: 40.742 },
        ],
      },
      {
        type: 'way',
        id: 12,
        tags: { building: 'yes' }, // not a highway: ignored
        geometry: [
          { lon: -73.99, lat: 40.743 },
          { lon: -73.988, lat: 40.743 },
        ],
      },
      {
        type: 'way',
        id: 13,
        tags: { highway: 'path' },
        geometry: [{ lon: -73.99, lat: 40.744 }], // single point: dropped
      },
    ],
  };

  it('keeps classified ways with deduped points', () => {
    const ways = parseOverpassRoads(data);
    expect(ways).toHaveLength(2);
    expect(ways[0].id).toBe('way/10');
    expect(ways[0].name).toBe('West 21st Street');
    expect(ways[0].points).toHaveLength(2);
    expect(ways[1].kind).toBe('sidewalk');
  });

  it('returns [] for malformed payloads', () => {
    expect(parseOverpassRoads(null)).toEqual([]);
    expect(parseOverpassRoads({})).toEqual([]);
    expect(parseOverpassRoads({ elements: 'nope' })).toEqual([]);
  });
});

describe('roadsQuery', () => {
  it('queries highway ways around the point', () => {
    const q = roadsQuery(-73.9897, 40.7411, 350);
    expect(q).toContain('way["highway"]');
    expect(q).toContain('around:350,40.7411000,-73.9897000');
    expect(q).toContain('out geom;');
  });
});

describe('lonLatToLocal', () => {
  it('converts degrees to metres at the equator', () => {
    const [x, y] = lonLatToLocal([0.001, 0], [0, 0]);
    expect(x).toBeCloseTo(111.195, 2);
    expect(y).toBeCloseTo(0, 6);
    const [x2, y2] = lonLatToLocal([0, 0.001], [0, 0]);
    expect(x2).toBeCloseTo(0, 6);
    expect(y2).toBeCloseTo(111.195, 2);
  });
});

describe('subdivideLonLat', () => {
  it('inserts points so no segment exceeds the step', () => {
    const out = subdivideLonLat([[0, 0], [0.001, 0]], 10); // ~111.2 m segment
    expect(out.length).toBe(13); // 1 + ceil(111.195 / 10) = 1 + 12
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([0.001, 0]);
  });

  it('leaves short ways untouched', () => {
    expect(subdivideLonLat([[0, 0], [0.00001, 0]], 10)).toHaveLength(2);
  });
});

describe('ribbonFromPoints', () => {
  it('builds a width-wide ribbon along a straight line', () => {
    const r = ribbonFromPoints([[0, 0, 0], [10, 0, 0]], 4);
    expect(r).not.toBeNull();
    expect(Array.from(r!.positions)).toEqual([0, 2, 0, 0, -2, 0, 10, 2, 0, 10, -2, 0]);
    expect(Array.from(r!.indices)).toEqual([0, 1, 2, 2, 1, 3]);
    // Edge pair distance equals the width.
    const dx = r!.positions[0] - r!.positions[3];
    const dy = r!.positions[1] - r!.positions[4];
    expect(Math.hypot(dx, dy)).toBeCloseTo(4);
  });

  it('handles a bend without NaNs and keeps z from the centreline', () => {
    const r = ribbonFromPoints([[0, 0, 5], [10, 0, 6], [10, 10, 7]], 2);
    expect(r).not.toBeNull();
    expect(r!.positions.length).toBe(18);
    expect(Array.from(r!.positions).every(Number.isFinite)).toBe(true);
    expect(r!.positions[2]).toBe(5);
    expect(r!.positions[8]).toBe(6);
  });

  it('returns null for degenerate input', () => {
    expect(ribbonFromPoints([[0, 0, 0]], 4)).toBeNull();
    expect(ribbonFromPoints([[0, 0, 0], [0, 0, 0]], 4)).toBeNull();
    expect(ribbonFromPoints([[0, 0, 0], [10, 0, 0]], 0)).toBeNull();
  });
});
