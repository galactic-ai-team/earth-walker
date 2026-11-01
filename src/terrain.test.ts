// src/terrain.test.ts — terrain decode, resampling and heightAt (lane 1, owner: Claude).
// No network: heightAt is exercised through createHeightSampler with a fake loader.
import { describe, expect, it, vi } from 'vitest';

import {
  GRID_SIZE,
  MAX_LEVEL,
  TILE_SIZE,
  createHeightCache,
  createHeightSampler,
  createTerrainProvider,
  decodeTerrarium,
  decodeTilePixels,
  lonLatToTile,
  resampleToGrid,
  sampleBilinear,
  tileUrl,
} from './terrain';

/** Encode metres to a Terrarium pixel, the inverse of decodeTerrarium. */
function encode(h: number): [number, number, number] {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - r * 256 - g) * 256);
  return [r, g, b];
}

describe('decodeTerrarium', () => {
  it('matches the published formula at known points', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0); // sea level
    expect(decodeTerrarium(162, 144, 0)).toBe(8848); // Everest
    expect(decodeTerrarium(128, 0, 128)).toBe(0.5); // blue carries 1/256 m steps
    expect(decodeTerrarium(0, 0, 0)).toBe(-32768); // lowest encodable
    expect(decodeTerrarium(126, 85, 0)).toBe(-427); // Dead Sea shore, below sea level
  });

  it('round-trips through the encoder to 1/256 m', () => {
    for (const h of [-10_994, -427, 0, 1.25, 4_478.5, 8_848.86]) {
      const [r, g, b] = encode(h);
      expect(Math.abs(decodeTerrarium(r, g, b) - h)).toBeLessThanOrEqual(1 / 512);
    }
  });
});

describe('decodeTilePixels', () => {
  it('decodes RGBA row-major and ignores alpha', () => {
    const rgba = new Uint8ClampedArray([
      ...encode(100), 255, ...encode(200), 0,
      ...encode(-50), 255, ...encode(4478), 17,
    ]);
    expect(Array.from(decodeTilePixels(rgba, 2))).toEqual([100, 200, -50, 4478]);
  });
});

describe('sampleBilinear', () => {
  const grid = [0, 10, 20, 30]; // 2x2: NW=0, NE=10, SW=20, SE=30

  it('hits pixel centres exactly and interpolates between them', () => {
    expect(sampleBilinear(grid, 2, 0, 0)).toBe(0);
    expect(sampleBilinear(grid, 2, 1, 1)).toBe(30);
    expect(sampleBilinear(grid, 2, 0.5, 0)).toBe(5);
    expect(sampleBilinear(grid, 2, 0.5, 0.5)).toBe(15);
  });

  it('clamps outside the grid instead of reading out of bounds', () => {
    expect(sampleBilinear(grid, 2, -3, -3)).toBe(0);
    expect(sampleBilinear(grid, 2, 9, 9)).toBe(30);
    expect(Number.isFinite(sampleBilinear(grid, 2, 1, 0.25))).toBe(true);
  });
});

describe('resampleToGrid', () => {
  it('keeps a flat tile flat', () => {
    const flat = new Float32Array(TILE_SIZE * TILE_SIZE).fill(1234.5);
    const out = resampleToGrid(flat, TILE_SIZE, GRID_SIZE);
    expect(out.length).toBe(GRID_SIZE * GRID_SIZE);
    expect(out.every((v) => v === 1234.5)).toBe(true);
  });

  it('reproduces a west-east ramp and keeps north-first row order', () => {
    // Height = column index along x, plus 1000 * row index along y (north = row 0).
    const src = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) src[y * TILE_SIZE + x] = x + 1000 * y;
    const out = resampleToGrid(src, TILE_SIZE, GRID_SIZE);
    const mid = (GRID_SIZE - 1) / 2;
    // Centre sample sits on the tile centre, between pixels 127 and 128.
    expect(out[mid * GRID_SIZE + mid]).toBeCloseTo(127.5 + 1000 * 127.5, 6);
    // Interior samples follow the ramp exactly (bilinear is exact on linear data).
    expect(out[mid * GRID_SIZE + 16]).toBeCloseTo(16 * 4 - 0.5 + 1000 * 127.5, 6);
    // Edges clamp to the outermost pixel centres.
    expect(out[0]).toBe(0); // NW corner
    expect(out[GRID_SIZE - 1]).toBe(255); // NE corner
    expect(out[(GRID_SIZE - 1) * GRID_SIZE]).toBe(255_000); // SW corner: south row last
  });
});

describe('lonLatToTile', () => {
  it('finds the right zoom-15 tile for New York City', () => {
    const t = lonLatToTile(-74.006, 40.7128, 15);
    expect([t.x, t.y]).toEqual([9647, 12320]);
    expect(t.px).toBeGreaterThanOrEqual(-0.5);
    expect(t.px).toBeLessThan(TILE_SIZE - 0.5);
    expect(t.py).toBeGreaterThanOrEqual(-0.5);
    expect(t.py).toBeLessThan(TILE_SIZE - 0.5);
  });

  it('puts (0, 0) at the corner shared by the four zoom-1 tiles', () => {
    const t = lonLatToTile(0, 0, 1);
    expect([t.x, t.y]).toEqual([1, 1]);
    expect(t.px).toBeCloseTo(-0.5, 9);
    expect(t.py).toBeCloseTo(-0.5, 9);
  });

  it('wraps longitude and clamps latitude to the Web Mercator limit', () => {
    expect(lonLatToTile(181, 10, 4).x).toBe(lonLatToTile(-179, 10, 4).x);
    const north = lonLatToTile(10, 89.9, 4);
    expect(north.y).toBe(0);
    const south = lonLatToTile(10, -89.9, 4);
    expect(south.y).toBe(15);
  });

  it('builds the keyless Terrarium URL', () => {
    expect(tileUrl(15, 9647, 12320)).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/9647/12320.png',
    );
  });
});

describe('createTerrainProvider', () => {
  it('uses Web Mercator XYZ tiling to zoom 15 with no water mask or normals', () => {
    const p = createTerrainProvider();
    expect(p.tilingScheme.getNumberOfXTilesAtLevel(0)).toBe(1);
    expect(p.tilingScheme.getNumberOfYTilesAtLevel(0)).toBe(1);
    expect(p.hasWaterMask).toBe(false);
    expect(p.hasVertexNormals).toBe(false);
    expect(p.getTileDataAvailable(0, 0, MAX_LEVEL)).toBe(true);
    expect(p.getTileDataAvailable(0, 0, MAX_LEVEL + 1)).toBe(false);
    expect(p.getLevelMaximumGeometricError(1)).toBeCloseTo(p.getLevelMaximumGeometricError(0) / 2, 9);
    expect(p.requestTileGeometry(0, 0, MAX_LEVEL + 1)).toBeUndefined();
  });
});

describe('heightAt (via createHeightSampler)', () => {
  /** A fake tile whose height is a known function of pixel position. */
  function rampTile(): Float32Array {
    const t = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) t[y * TILE_SIZE + x] = 10 * x + y;
    return t;
  }

  it('requests the right tile and interpolates inside it', async () => {
    const loader = vi.fn(async () => rampTile());
    const heightAt = createHeightSampler(loader);
    const lon = -74.006;
    const lat = 40.7128;
    const t = lonLatToTile(lon, lat, 15);
    const h = await heightAt(lon, lat);
    expect(loader).toHaveBeenCalledWith(15, 9647, 12320);
    expect(h).toBeCloseTo(10 * t.px + t.py, 3);
  });

  it('shares one download between concurrent requests and caches the tile', async () => {
    const loader = vi.fn(async () => rampTile());
    const heightAt = createHeightSampler(loader);
    await Promise.all([heightAt(7.66, 45.98), heightAt(7.66001, 45.98001), heightAt(7.66, 45.98)]);
    await heightAt(7.66, 45.98);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used tile when the cache is full', async () => {
    const loader = vi.fn(async () => rampTile());
    const heightAt = createHeightSampler(loader, { cacheSize: 2 });
    await heightAt(0.001, 0.001); // tile A
    await heightAt(10, 10); // tile B
    await heightAt(0.001, 0.001); // A again: now most recent
    await heightAt(20, 20); // tile C evicts B
    expect(loader).toHaveBeenCalledTimes(3);
    await heightAt(0.001, 0.001); // A still cached
    expect(loader).toHaveBeenCalledTimes(3);
    await heightAt(10, 10); // B was evicted
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures, so a later call retries', async () => {
    const loader = vi
      .fn<(z: number, x: number, y: number) => Promise<Float32Array>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(rampTile());
    const heightAt = createHeightSampler(loader);
    await expect(heightAt(1, 1)).rejects.toThrow('offline');
    await expect(heightAt(1, 1)).resolves.toBeTypeOf('number');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects non-finite input', async () => {
    const heightAt = createHeightSampler(async () => rampTile());
    await expect(heightAt(Number.NaN, 0)).rejects.toThrow(RangeError);
    await expect(heightAt(0, Infinity)).rejects.toThrow(RangeError);
  });
});
describe('tryHeightAt (via createHeightCache)', () => {
  function flatTile(h: number): Float32Array {
    return new Float32Array(TILE_SIZE * TILE_SIZE).fill(h);
  }

  it('returns undefined and starts loading, then answers synchronously once loaded', async () => {
    let resolve!: (t: Float32Array) => void;
    const loader = vi.fn(() => new Promise<Float32Array>((r) => (resolve = r)));
    const c = createHeightCache(loader);
    expect(c.tryHeightAt(7.66, 45.98)).toBeUndefined();
    expect(c.tryHeightAt(7.66, 45.98)).toBeUndefined(); // still one download
    expect(loader).toHaveBeenCalledTimes(1);
    resolve(flatTile(3200));
    await c.heightAt(7.66, 45.98);
    expect(c.tryHeightAt(7.66, 45.98)).toBe(3200);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a failed tile is retried on the next call instead of sticking', async () => {
    const loader = vi
      .fn<(z: number, x: number, y: number) => Promise<Float32Array>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(flatTile(10));
    const c = createHeightCache(loader);
    expect(c.tryHeightAt(1, 1)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0)); // let the rejection settle
    expect(c.tryHeightAt(1, 1)).toBeUndefined(); // retry starts
    await c.heightAt(1, 1);
    expect(c.tryHeightAt(1, 1)).toBe(10);
    expect(loader).toHaveBeenCalledTimes(2);
  });

});
