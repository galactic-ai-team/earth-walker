import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
  OFM_ATTRIBUTION,
  OFM_MAX_TILES,
  clipRingToSquare,
  decodeBuildingTile,
  featureToFootprints,
  fetchOfmBuildings,
  getOfmTileTemplate,
  lonLatToTile,
  ofmHeights,
  radiusBounds,
  selectFootprints,
  signedArea,
  tilePointToLonLat,
  tileUrl,
  tilesForRadius,
  type OfmFeatureLike,
} from './buildingsOfm';
import {
  clearBuildings,
  footprintBlocks,
  getBuildingFootprints,
  isBlocked,
  loadBuildingsAround,
} from './buildings';

import { OFM_FIXTURE_TILE, ofmFixtureBytes } from './__fixtures__/ofmTile';

// Real OpenFreeMap z14 tile (planet 20261025), building layer only,
// Bernese Oberland CH: 4 merged multipolygon features.
const FIXTURE_TILE = { ...OFM_FIXTURE_TILE };
const FIXTURE = ofmFixtureBytes();
const TEMPLATE = 'https://tiles.example/planet/{z}/{x}/{y}.pbf';

function tileBounds(t: { z: number; x: number; y: number }) {
  const [west, north] = tilePointToLonLat(t.z, t.x, t.y);
  const [east, south] = tilePointToLonLat(t.z, t.x + 1, t.y + 1);
  return { west, south, east, north };
}

describe('OpenFreeMap tile math', () => {
  it('maps lon/lat to the containing tile', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
    expect(lonLatToTile(-73.9897, 40.7411, 14)).toEqual({
      x: 4824,
      y: 6158,
    });
    expect(lonLatToTile(7.8992, 46.5513, 14)).toEqual({
      x: FIXTURE_TILE.x,
      y: FIXTURE_TILE.y,
    });
    // clamps at the antimeridian / mercator limit
    expect(lonLatToTile(180, -89, 2)).toEqual({ x: 3, y: 3 });
  });

  it('inverts tile corners back to lon/lat', () => {
    const [lon, lat] = tilePointToLonLat(14, 4824.5, 6158.5);
    expect(lonLatToTile(lon, lat, 14)).toEqual({ x: 4824, y: 6158 });
    expect(tilePointToLonLat(0, 0, 0)[0]).toBeCloseTo(-180);
    expect(tilePointToLonLat(0, 0, 0)[1]).toBeCloseTo(85.0511, 3);
    expect(tilePointToLonLat(1, 1, 1)[1]).toBeCloseTo(0, 9);
  });

  it('builds a metre-correct radius bbox', () => {
    const b = radiusBounds(0, 60, 1113.2);
    expect(b.north - 60).toBeCloseTo(0.01, 6);
    // lon degrees are twice as long at 60° latitude
    expect(b.east).toBeCloseTo(0.02, 4);
  });

  it('covers a small radius with the centre tile first', () => {
    const [lon, lat] = tilePointToLonLat(14, 4824.5, 6158.5);
    expect(tilesForRadius(lon, lat, 100)).toEqual([
      { z: 14, x: 4824, y: 6158 },
    ]);
  });

  it('adds neighbours when the radius crosses a tile edge', () => {
    // just east of the west edge of tile 4824/6158
    const [lon, lat] = tilePointToLonLat(14, 4824.02, 6158.5);
    const tiles = tilesForRadius(lon, lat, 200);
    expect(tiles[0]).toEqual({ z: 14, x: 4824, y: 6158 });
    expect(tiles).toContainEqual({ z: 14, x: 4823, y: 6158 });
    expect(tiles).toHaveLength(2);
  });

  it('needs at most 4 tiles at the 800 m loader cap, never > max', () => {
    const tiles = tilesForRadius(-73.9897, 40.7411, 800);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
    expect(tilesForRadius(-73.9897, 40.7411, 20_000)).toHaveLength(
      OFM_MAX_TILES,
    );
  });

  it('fills the TileJSON URL template', () => {
    expect(tileUrl(TEMPLATE, { z: 14, x: 1, y: 2 })).toBe(
      'https://tiles.example/planet/14/1/2.pbf',
    );
  });
});

describe('OpenFreeMap geometry', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
  ];

  it('uses the MVT winding convention (outer > 0, hole < 0)', () => {
    expect(signedArea(square)).toBe(100);
    expect(signedArea(square.slice().reverse())).toBe(-100);
  });

  it('clips rings to the tile square', () => {
    const ring = [
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 },
    ];
    const clipped = clipRingToSquare(ring, 4096);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(25);
    for (const p of clipped) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
    expect(clipRingToSquare(ring.map((p) => ({ x: p.x - 10, y: p.y })), 4096))
      .toEqual([]);
  });

  it('maps render_height / render_min_height', () => {
    expect(ofmHeights({ render_height: 40, render_min_height: 12 }))
      .toEqual({ heightM: 40, minHeightM: 12 });
    expect(ofmHeights({})).toEqual({ heightM: 10, minHeightM: 0 });
    expect(ofmHeights({ render_height: 5, render_min_height: 4 }))
      .toEqual({ heightM: 6, minHeightM: 4 });
  });

  it('converts a hand-built feature: outer rings only, in degrees', () => {
    const outer = [
      { x: 1024, y: 1024 },
      { x: 3072, y: 1024 },
      { x: 3072, y: 3072 },
      { x: 1024, y: 3072 },
      { x: 1024, y: 1024 },
    ];
    const hole = [
      { x: 1500, y: 1500 },
      { x: 1500, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 1500 },
      { x: 1500, y: 1500 },
    ];
    const feature: OfmFeatureLike = {
      type: 3,
      extent: 4096,
      properties: { render_height: 30, render_min_height: 0 },
      loadGeometry: () => [outer, hole] as never,
    };
    const tile = { z: 14, x: 4824, y: 6158 };
    const [fp, ...rest] = featureToFootprints(feature, tile, 'ofm:t');

    expect(rest).toEqual([]);
    expect(fp.id).toBe('ofm:t:0');
    expect(fp.ring).toHaveLength(4); // closing point dropped
    expect(fp.heightM).toBe(30);
    expect(fp.minHeightM).toBe(0);

    const [cLon, cLat] = tilePointToLonLat(14, 4824.5, 6158.5);
    expect(fp.center[0]).toBeCloseTo(cLon, 9);
    expect(fp.center[1]).toBeCloseTo(cLat, 6);
    expect(footprintBlocks(cLon, cLat, fp, 0)).toBe(true);

    const [wLon] = tilePointToLonLat(14, 4824.25, 6158.5);
    expect(fp.bounds.west).toBeCloseTo(wLon, 9);

    // non-polygons are ignored
    expect(featureToFootprints({ ...feature, type: 2 }, tile, 'x'))
      .toEqual([]);
  });
});

describe('OpenFreeMap real tile fixture', () => {
  const footprints = decodeBuildingTile(FIXTURE, FIXTURE_TILE);
  const layer = new VectorTile(new PbfReader(FIXTURE)).layers.building;

  it('decodes building footprints with the Overpass shape', () => {
    expect(layer.length).toBe(4);
    expect(footprints.length).toBeGreaterThan(50);

    const tb = tileBounds(FIXTURE_TILE);
    const eps = 1e-9;
    const heights = new Set<number>();
    for (let i = 0; i < layer.length; i++) {
      heights.add(Number(layer.feature(i).properties.render_height));
    }

    for (const f of footprints) {
      expect(f.id).toMatch(/^ofm:14\/8551\/5792:\d+:\d+$/);
      expect(f.ring.length).toBeGreaterThanOrEqual(3);
      expect(heights.has(f.heightM)).toBe(true);
      expect(f.minHeightM).toBe(0);
      expect(f.bounds.west).toBeGreaterThanOrEqual(tb.west - eps);
      expect(f.bounds.east).toBeLessThanOrEqual(tb.east + eps);
      expect(f.bounds.south).toBeGreaterThanOrEqual(tb.south - eps);
      expect(f.bounds.north).toBeLessThanOrEqual(tb.north + eps);
      // a vertex lies on the footprint edge -> blocked
      expect(footprintBlocks(f.ring[0][0], f.ring[0][1], f, 0)).toBe(true);
    }

    expect(new Set(footprints.map((f) => f.id)).size).toBe(
      footprints.length,
    );
  });

  it('selects nearest footprints within the radius, capped', () => {
    const [lon, lat] = footprints[0].center;
    const picked = selectFootprints(footprints, lon, lat, 300, 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]).toBe(footprints[0]);
    expect(selectFootprints(footprints, 0, 0, 300, 800)).toEqual([]);
  });
});

function fixtureFetcher(log: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    if (url === 'https://tiles.openfreemap.org/planet') {
      return new Response(JSON.stringify({ tiles: [TEMPLATE] }));
    }
    if (url.includes('overpass')) {
      throw new TypeError('TLS failure');
    }
    if (url === tileUrl(TEMPLATE, FIXTURE_TILE)) {
      return new Response(FIXTURE);
    }
    return new Response('', { status: 404 });
  });
}

describe('fetchOfmBuildings', () => {
  const [lon, lat] = tilePointToLonLat(14, 8551.5, 5792.5);

  it('loads, decodes and filters tiles (tolerates partial failure)', async () => {
    const log: string[] = [];
    const result = await fetchOfmBuildings(lon, lat, 800, {
      fetcher: fixtureFetcher(log) as unknown as typeof fetch,
      tileUrlTemplate: TEMPLATE,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(log.length).toBe(tilesForRadius(lon, lat, 800).length);
  });

  it('throws when every tile fails', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      fetchOfmBuildings(lon, lat, 100, {
        fetcher: fetcher as unknown as typeof fetch,
        tileUrlTemplate: TEMPLATE,
      }),
    ).rejects.toThrow('OpenFreeMap: all 1 tiles failed');
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchOfmBuildings(lon, lat, 100, {
        fetcher: fixtureFetcher() as unknown as typeof fetch,
        tileUrlTemplate: TEMPLATE,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it('reads the dated tile URL from the TileJSON', async () => {
    const fetcher = fixtureFetcher();
    await expect(
      getOfmTileTemplate(fetcher as unknown as typeof fetch),
    ).resolves.toBe(TEMPLATE);
  });
});

describe('loadBuildingsAround OpenFreeMap fallback', () => {
  afterEach(() => {
    clearBuildings();
    vi.unstubAllGlobals();
  });

  it('renders OFM buildings, credits them and feeds isBlocked when Overpass is down', async () => {
    vi.stubGlobal('fetch', fixtureFetcher());

    const added: unknown[] = [];
    const credits = new Set<{ html: string }>();
    const viewer = {
      scene: { globe: { getHeight: () => 1000 } },
      entities: {
        add: (e: unknown) => {
          added.push(e);
          return e;
        },
        remove: (e: unknown) => {
          added.splice(added.indexOf(e), 1);
          return true;
        },
      },
      creditDisplay: {
        addStaticCredit: (c: { html: string }) => credits.add(c),
        removeStaticCredit: (c: { html: string }) => credits.delete(c),
      },
    };

    const [lon, lat] = tilePointToLonLat(14, 8551.5, 5792.5);
    const count = await loadBuildingsAround(
      viewer as never,
      lon,
      lat,
      800,
    );

    expect(count).toBeGreaterThan(0);
    expect(added).toHaveLength(count);
    expect(getBuildingFootprints()).toHaveLength(count);

    const f = getBuildingFootprints()[0];
    expect(isBlocked(f.ring[0][0], f.ring[0][1], 0)).toBe(true);

    const html = [...credits].map((c) => c.html).join(' ');
    expect(html.replace(/<[^>]+>/g, '')).toContain(OFM_ATTRIBUTION);

    clearBuildings();
    expect(credits.size).toBe(0);
    expect(isBlocked(f.ring[0][0], f.ring[0][1], 0)).toBe(false);
  });
});
