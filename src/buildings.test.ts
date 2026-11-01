import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  DEFAULT_BUILDING_HEIGHT_M,
  METRES_PER_LEVEL,
  parseLength,
  parseBuildingHeight,
  parseOverpassBuildings,
  pointInFootprint,
  footprintBlocks,
  type OverpassResponse,
} from './buildings';

const example: OverpassResponse = {
  elements: [
    {
      type: 'way',
      id: 12345,
      tags: {
        building: 'residential',
        name: 'Test Building',
        'building:levels': '4',
      },
      geometry: [
        { lon: -73.8, lat: 40.7 },
        { lon: -73.7999, lat: 40.7 },
        { lon: -73.7999, lat: 40.7001 },
        { lon: -73.8, lat: 40.7001 },
        { lon: -73.8, lat: 40.7 },
      ],
    },
  ],
};

describe('OSM height parsing', () => {
  it('accepts metres', () => {
    expect(parseLength('12 m')).toBe(12);
    expect(parseLength('15.5')).toBe(15.5);
  });

  it('converts feet to metres', () => {
    expect(parseLength('40 ft')).toBeCloseTo(12.192);
  });

  it('rejects invalid heights', () => {
    expect(parseLength('unknown')).toBeNull();
    expect(parseLength('-5')).toBeNull();
  });

  it('prefers explicit height', () => {
    expect(
      parseBuildingHeight({
        height: '18',
        'building:levels': '3',
      }).heightM,
    ).toBe(18);
  });

  it('uses levels when height is absent', () => {
    expect(
      parseBuildingHeight({
        'building:levels': '4',
      }).heightM,
    ).toBe(4 * METRES_PER_LEVEL);
  });

  it('uses the default for unknown buildings', () => {
    expect(
      parseBuildingHeight({}).heightM,
    ).toBe(DEFAULT_BUILDING_HEIGHT_M);
  });

  it('supports elevated buildings', () => {
    const height = parseBuildingHeight({
      height: '20',
      min_height: '4',
    });

    expect(height.heightM).toBe(20);
    expect(height.minHeightM).toBe(4);
  });
});

describe('Overpass footprints', () => {
  it('parses a closed way', () => {
    const buildings = parseOverpassBuildings(example);

    expect(buildings).toHaveLength(1);
    expect(buildings[0].id).toBe('osm:way:12345');
    expect(buildings[0].name).toBe('Test Building');
    expect(buildings[0].ring).toHaveLength(4);
    expect(buildings[0].heightM).toBe(12);
  });

  it('does not duplicate OSM ways', () => {
    const buildings = parseOverpassBuildings({
      elements: [
        example.elements[0],
        example.elements[0],
      ],
    });

    expect(buildings).toHaveLength(1);
  });

  it('ignores invalid or nonbuilding geometry', () => {
    const buildings = parseOverpassBuildings({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { highway: 'residential' },
          geometry: example.elements[0].geometry,
        },
        {
          type: 'way',
          id: 2,
          tags: { building: 'yes' },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 1 },
          ],
        },
      ],
    });

    expect(buildings).toHaveLength(0);
  });

  it('detects a point inside the building', () => {
    const building = parseOverpassBuildings(example)[0];

    expect(
      pointInFootprint(
        -73.79995,
        40.70005,
        building.ring,
      ),
    ).toBe(true);
  });

  it('does not block a distant point', () => {
    const building = parseOverpassBuildings(example)[0];

    expect(
      footprintBlocks(
        -73.81,
        40.71,
        building,
      ),
    ).toBe(false);
  });

  it('blocks a walker inside a building', () => {
    const building = parseOverpassBuildings(example)[0];

    expect(
      footprintBlocks(
        -73.79995,
        40.70005,
        building,
        0.4,
      ),
    ).toBe(true);
  });

  it('supports collision clearance near walls', () => {
    const building = parseOverpassBuildings(example)[0];

    // Roughly 0.2m west of the wall.
    expect(
      footprintBlocks(
        -73.8000024,
        40.70005,
        building,
        0.4,
      ),
    ).toBe(true);

    expect(
      footprintBlocks(
        -73.8000024,
        40.70005,
        building,
        0,
      ),
    ).toBe(false);
  });
});

