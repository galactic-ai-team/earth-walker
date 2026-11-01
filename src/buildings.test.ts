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

import { vi } from 'vitest';
import {
  fetchOverpassWithFallback,
} from './buildings';

describe('Overpass mirror fallback', () => {
  const endpoints = [
    'https://first.example/api/interpreter',
    'https://second.example/api/interpreter',
    'https://third.example/api/interpreter',
  ];

  const success = {
    elements: [{ type: 'way', id: 123 }],
  };

  it('tries mirrors in order after HTTP and network failures', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
      })
      .mockRejectedValueOnce(
        new TypeError('Network error'),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => success,
      });

    const result = await fetchOverpassWithFallback(
      '[out:json];out;',
      {
        endpoints,
        fetcher: fetcher as unknown as typeof fetch,
      },
    );

    expect(result).toEqual(success);
    expect(fetcher).toHaveBeenCalledTimes(3);

    for (let i = 0; i < endpoints.length; i++) {
      expect(fetcher.mock.calls[i][0]).toContain(
        endpoints[i],
      );
    }
  });

  it('stops at the first successful endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => success,
    });

    await fetchOverpassWithFallback(
      'test',
      {
        endpoints,
        fetcher: fetcher as unknown as typeof fetch,
      },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty result without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [] }),
    });

    const result = await fetchOverpassWithFallback(
      'test',
      {
        endpoints,
        fetcher: fetcher as unknown as typeof fetch,
      },
    );

    expect(result.elements).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries after malformed JSON', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'broken' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => success,
      });

    const result = await fetchOverpassWithFallback(
      'test',
      {
        endpoints,
        fetcher: fetcher as unknown as typeof fetch,
      },
    );

    expect(result).toEqual(success);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports an error when all mirrors fail', async () => {
    const fetcher = vi.fn().mockRejectedValue(
      new TypeError('TLS failure'),
    );

    await expect(
      fetchOverpassWithFallback('test', {
        endpoints,
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow('All 3 Overpass endpoints failed');

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not try another mirror after cancellation', async () => {
    const controller = new AbortController();

    const fetcher = vi.fn().mockImplementation(
      async () => {
        controller.abort(
          new DOMException('Cancelled', 'AbortError'),
        );
        throw new DOMException(
          'Cancelled',
          'AbortError',
        );
      },
    );

    await expect(
      fetchOverpassWithFallback('test', {
        endpoints,
        signal: controller.signal,
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('moves to the next mirror after a timeout', async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => reject(
                new DOMException('Timed out', 'AbortError'),
              ),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => success,
      });

    const result = await fetchOverpassWithFallback(
      'test',
      {
        endpoints,
        timeoutMs: 15,
        fetcher: fetcher as unknown as typeof fetch,
      },
    );

    expect(result).toEqual(success);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
