// src/terrain.ts — earth-walker terrain + height pipeline (lane 1, owner: Claude).
//
// Keyless elevation from the AWS Terrain Tiles open dataset ("Terrarium"
// PNG encoding, Web Mercator XYZ tiles, zoom 0..15, 256x256 pixels):
//   height (m) = R * 256 + G + B / 256 - 32768
//
// Two exports for the rest of the app:
//   - createTerrainProvider(): a CesiumJS TerrainProvider that streams those
//     tiles and resamples each one to a 65x65 heightmap whose edge samples
//     lie exactly on the tile boundary (what Cesium expects). Cesium's skirts
//     hide the small seams between neighbouring tiles.
//   - heightAt(lon, lat): ground height in metres from the full-resolution
//     zoom-15 tile (~4.8 m per pixel at the equator, finer toward the poles),
//     bilinearly interpolated. Tiles are cached, and concurrent requests for
//     the same tile share one download.
//
// Note for the walker: the globe draws a simplified mesh. Even fully refined,
// each zoom-15 tile becomes a 65x65 grid (~19 m between samples at the
// equator), while heightAt() reads the full 256x256 data (~4.8 m). On uneven
// ground the two can differ by a metre or more, so feet placed at heightAt()
// may look slightly sunk or floating. For visual contact, prefer
// scene.globe.getHeight() (the drawn surface; undefined until that tile has
// loaded) and fall back to heightAt() when it returns undefined. If the gap
// shows, GRID_SIZE can go up to 129 or 257 at the cost of heavier meshes.
//
// Heights include ocean bathymetry (negative below sea level), and real land
// below sea level (the Dead Sea, parts of the Netherlands) stays negative too.
//
// Datum: the tiles give height above mean sea level, while Cesium treats
// terrain heights as height above the WGS84 ellipsoid. The difference (the
// geoid, roughly -33 m in New York and +50 m in the Alps) is harmless as long
// as everything we place (buildings, the walker) uses this terrain. It
// matters only if we later add data in true ellipsoidal heights, such as
// photorealistic 3D tiles: that data would float or sink by that offset.

import {
  Credit,
  Ellipsoid,
  Event,
  HeightmapTerrainData,
  Resource,
  TerrainProvider,
  WebMercatorTilingScheme,
  type Request,
  type TerrainData,
  type TileAvailability,
} from 'cesium';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Deepest zoom level published by the dataset. */
export const MAX_LEVEL = 15;
/** Source tile size in pixels. */
export const TILE_SIZE = 256;
/** Heightmap samples per side handed to Cesium (edge-aligned). */
export const GRID_SIZE = 65;
/** Web Mercator latitude limit, degrees. */
export const MAX_LATITUDE = 85.05112878;

const ATTRIBUTION =
  'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">' +
  'Terrain Tiles</a> (AWS Open Data; USGS 3DEP, SRTM, GMTED2010, ETOPO1, EU-DEM and others)';

// ---- pure math (no network, no DOM; unit-tested) ----------------------------

/** Decode one Terrarium pixel to metres. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Decode an RGBA pixel buffer (row-major, north row first) into heights. */
export function decodeTilePixels(rgba: ArrayLike<number>, size: number, out = new Float32Array(size * size)): Float32Array {
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    out[i] = decodeTerrarium(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  return out;
}

/**
 * Bilinear sample of a square height grid at pixel coordinates (px, py),
 * where (0, 0) is the CENTRE of the north-west pixel. Coordinates outside
 * the grid are clamped to the edge pixels.
 */
export function sampleBilinear(heights: ArrayLike<number>, size: number, px: number, py: number): number {
  const max = size - 1;
  const x = px < 0 ? 0 : px > max ? max : px;
  const y = py < 0 ? 0 : py > max ? max : py;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 < max ? x0 + 1 : max;
  const y1 = y0 < max ? y0 + 1 : max;
  const fx = x - x0;
  const fy = y - y0;
  const top = heights[y0 * size + x0] * (1 - fx) + heights[y0 * size + x1] * fx;
  const bottom = heights[y1 * size + x0] * (1 - fx) + heights[y1 * size + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Resample pixel-centred source heights to a grid whose first and last
 * samples sit exactly on the tile edges (Cesium's heightmap convention:
 * row-major, north to south, west to east).
 */
export function resampleToGrid(
  heights: ArrayLike<number>,
  srcSize: number,
  gridSize: number,
  out = new Float32Array(gridSize * gridSize),
): Float32Array {
  const step = srcSize / (gridSize - 1);
  for (let j = 0; j < gridSize; j++) {
    const py = j * step - 0.5;
    for (let i = 0; i < gridSize; i++) {
      out[j * gridSize + i] = sampleBilinear(heights, srcSize, i * step - 0.5, py);
    }
  }
  return out;
}

export interface TileHit {
  /** Tile column and row (XYZ / Google scheme: y = 0 at the north). */
  x: number;
  y: number;
  /** Pixel coordinates inside the tile, (0, 0) = centre of the NW pixel. */
  px: number;
  py: number;
}

/** Which zoom-`z` tile contains (lon, lat), and where inside it. Degrees in. */
export function lonLatToTile(lon: number, lat: number, z: number): TileHit {
  const n = 2 ** z;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const xf = ((wrapped + 180) / 360) * n;
  const yf = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(xf)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(yf)));
  return { x, y, px: (xf - x) * TILE_SIZE - 0.5, py: (yf - y) * TILE_SIZE - 0.5 };
}

export function tileUrl(z: number, x: number, y: number): string {
  return TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

// ---- browser image decoding ---------------------------------------------------

type TileImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let scratchCtx: Ctx2D | null = null;

function context(): Ctx2D {
  if (scratchCtx) return scratchCtx;
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
      : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error('terrain: 2D canvas context unavailable');
  scratchCtx = ctx;
  return ctx;
}

/** Decode a fetched Terrarium tile image into a TILE_SIZE^2 height array. */
function imageToHeights(image: TileImage): Float32Array {
  const ctx = context();
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
  const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  if ('close' in image && typeof image.close === 'function') image.close();
  return decodeTilePixels(data, TILE_SIZE);
}

/**
 * Fetch one tile as an image. Pixel values must be read exactly, so colour
 * management is switched off. With a Cesium `request`, the fetch may be
 * throttled, in which case this returns undefined (Cesium retries later).
 */
function fetchTileImage(z: number, x: number, y: number, request?: Request): Promise<TileImage> | undefined {
  const resource = new Resource({ url: tileUrl(z, x, y), request });
  return resource.fetchImage({ preferImageBitmap: true, skipColorSpaceConversion: true }) as
    | Promise<TileImage>
    | undefined;
}

// ---- Cesium terrain provider ---------------------------------------------------

class TerrariumTerrainProvider {
  readonly tilingScheme = new WebMercatorTilingScheme({ ellipsoid: Ellipsoid.WGS84 });
  readonly errorEvent = new Event<TerrainProvider.ErrorEvent>();
  readonly credit = new Credit(ATTRIBUTION);
  readonly hasWaterMask = false;
  readonly hasVertexNormals = false;
  readonly availability: TileAvailability | undefined = undefined;

  private readonly levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
    Ellipsoid.WGS84,
    GRID_SIZE,
    this.tilingScheme.getNumberOfXTilesAtLevel(0),
  );

  requestTileGeometry(x: number, y: number, level: number, request?: Request): Promise<TerrainData> | undefined {
    if (level > MAX_LEVEL) return undefined;
    const image = fetchTileImage(level, x, y, request);
    if (!image) return undefined; // throttled; Cesium will ask again
    return image.then(
      (img) =>
        new HeightmapTerrainData({
          buffer: resampleToGrid(imageToHeights(img), TILE_SIZE, GRID_SIZE),
          width: GRID_SIZE,
          height: GRID_SIZE,
          // Below MAX_LEVEL all four children exist; at MAX_LEVEL Cesium upsamples.
          childTileMask: level < MAX_LEVEL ? 15 : 0,
        }),
    );
  }

  getLevelMaximumGeometricError(level: number): number {
    return this.levelZeroError / (1 << level);
  }

  getTileDataAvailable(_x: number, _y: number, level: number): boolean | undefined {
    return level <= MAX_LEVEL;
  }

  loadTileDataAvailability(_x: number, _y: number, _level: number): undefined | Promise<void> {
    return undefined;
  }
}

/** Keyless global terrain for the Cesium viewer (no ion, no sign-up). */
export function createTerrainProvider(): TerrainProvider {
  return new TerrariumTerrainProvider();
}

// ---- heightAt -----------------------------------------------------------------

/** Loads one zoom-15 tile as decoded heights (TILE_SIZE^2, north row first). */
export type TileHeightLoader = (z: number, x: number, y: number) => Promise<Float32Array>;

export interface HeightSamplerOptions {
  /** Tiles kept in memory (each ~256 KB). Default 64. */
  cacheSize?: number;
  /** Zoom level to sample. Default MAX_LEVEL (15). */
  zoom?: number;
}

export interface HeightCache {
  /** Height in metres; waits for the tile if needed. Rejects if it can't be fetched. */
  heightAt(lon: number, lat: number): Promise<number>;
  /**
   * Height in metres right now if the tile is already loaded; otherwise starts
   * loading it and returns undefined. Synchronous, so a per-frame loop (the
   * walker) can call it without awaiting.
   */
  tryHeightAt(lon: number, lat: number): number | undefined;
}

/**
 * Build a cached height lookup around a tile loader. The defaults below use
 * the network; tests pass a fake loader.
 */
export function createHeightCache(loadTile: TileHeightLoader, opts: HeightSamplerOptions = {}): HeightCache {
  const cacheSize = Math.max(1, opts.cacheSize ?? 64);
  const zoom = opts.zoom ?? MAX_LEVEL;
  // Map keeps insertion order, so the first key is the least recently used.
  const cache = new Map<string, Promise<Float32Array>>();
  // Tiles whose download has finished, for synchronous reads.
  const ready = new Map<string, Float32Array>();

  const evict = (): void => {
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      ready.delete(oldest);
    }
  };

  const tile = (x: number, y: number): Promise<Float32Array> => {
    const key = `${zoom}/${x}/${y}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const pending = loadTile(zoom, x, y);
    cache.set(key, pending);
    pending.then(
      (heights) => {
        if (cache.get(key) === pending) ready.set(key, heights);
      },
      () => {
        if (cache.get(key) === pending) cache.delete(key); // don't cache failures
      },
    );
    evict();
    return pending;
  };

  const check = (lon: number, lat: number, fn: string): void => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new RangeError(`${fn}: lon/lat must be finite numbers (got ${lon}, ${lat})`);
    }
  };

  return {
    async heightAt(lon, lat) {
      check(lon, lat, 'heightAt');
      const hit = lonLatToTile(lon, lat, zoom);
      const heights = await tile(hit.x, hit.y);
      return sampleBilinear(heights, TILE_SIZE, hit.px, hit.py);
    },
    tryHeightAt(lon, lat) {
      check(lon, lat, 'tryHeightAt');
      const hit = lonLatToTile(lon, lat, zoom);
      const key = `${zoom}/${hit.x}/${hit.y}`;
      const heights = ready.get(key);
      if (!heights) {
        void tile(hit.x, hit.y).catch(() => undefined); // start (or keep) loading; errors surface via heightAt
        return undefined;
      }
      tile(hit.x, hit.y); // refresh LRU order
      return sampleBilinear(heights, TILE_SIZE, hit.px, hit.py);
    },
  };
}

/**
 * Build a heightAt function around a tile loader (kept for compatibility;
 * createHeightCache also offers the synchronous tryHeightAt).
 */
export function createHeightSampler(
  loadTile: TileHeightLoader,
  opts: HeightSamplerOptions = {},
): (lon: number, lat: number) => Promise<number> {
  const c = createHeightCache(loadTile, opts);
  return (lon, lat) => c.heightAt(lon, lat);
}

const networkLoader: TileHeightLoader = async (z, x, y) => {
  const image = fetchTileImage(z, x, y);
  if (!image) throw new Error(`terrain: could not request tile ${z}/${x}/${y}`);
  return imageToHeights(await image);
};

const defaultCache = createHeightCache(networkLoader);

/**
 * Ground height in metres at (lon, lat) in degrees, on the same datum as the
 * terrain the globe draws (see the datum note at the top of this file).
 * Rejects if the tile can't be fetched.
 */
export async function heightAt(lon: number, lat: number): Promise<number> {
  return defaultCache.heightAt(lon, lat);
}

/**
 * Same height as heightAt(), but synchronous: returns undefined (and starts
 * the download) when the tile isn't in memory yet. For per-frame use.
 */
export function tryHeightAt(lon: number, lat: number): number | undefined {
  return defaultCache.tryHeightAt(lon, lat);
}

// ---- nearest land (for arrivals from Cosmoscope) ---------------------------------
//
// Cosmoscope's Earth is untextured, so a handoff often lands at sea, where
// these tiles give the seabed (often thousands of metres down). nearestLand()
// finds the closest dry ground instead:
//   1. If the spot itself is land, keep it.
//   2. Otherwise search outward in rings on coarse zoom-7 tiles (~1.2 km per
//      pixel, ~300 km per tile, so a 400 km search is at most a handful of
//      downloads), and take the nearest land point on the first ring with any.
//   3. Walk back along that bearing to find the shoreline, step a little
//      inland, and confirm with the full-resolution tiles.
// "Land" means height above OCEAN_BELOW_M, not above 0: Dutch polders (down to
// about -7 m) stay land, and shallow water right at a beach counts too, which
// just means arriving on the beach. The Dead Sea shore (-430 m) is the one
// real place this would move you away from; it snaps to the nearest higher
// ground.

/** Heights at or below this count as sea. */
export const OCEAN_BELOW_M = -10;
/** Zoom used for the ring search. */
export const LAND_SEARCH_ZOOM = 7;
/** Default search radius, metres. */
export const LAND_SEARCH_RADIUS_M = 400_000;
/** Ring radii, metres (each ring is searched only if the previous had no land). */
export const LAND_SEARCH_RINGS_M: readonly number[] = [
  1_000, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000, 150_000, 250_000, 400_000,
];
/** How far inland of the detected shoreline to land, metres. */
export const LAND_INLAND_MARGIN_M = 150;
/** Mid-ocean fallback: hover this high above sea level. */
export const OCEAN_HOVER_HEIGHT_M = 300;

const EARTH_MEAN_RADIUS_M = 6_371_008.8;

export interface LandHit {
  lon: number;
  lat: number;
  /** Ground height there (full-resolution tiles), metres. */
  height: number;
  /** Great-circle distance from the requested spot, metres. */
  distanceM: number;
}

export type HeightLookup = (lon: number, lat: number) => Promise<number>;

export interface NearestLandOptions {
  /** Full-resolution heights (default: heightAt). */
  fine?: HeightLookup;
  /** Coarse heights for the ring search (default: zoom-7 tiles). */
  coarse?: HeightLookup;
  maxRadiusM?: number;
}

/** Point `distanceM` from (lon, lat) along compass `bearingDeg` (great circle). */
export function destinationPoint(lon: number, lat: number, bearingDeg: number, distanceM: number): [number, number] {
  const d = distanceM / EARTH_MEAN_RADIUS_M;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  const lonOut = ((((l2 * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
  return [lonOut, (p2 * 180) / Math.PI];
}

/** Great-circle distance between two points, metres. */
export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dp = (lat2 - lat1) * r;
  const dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const isLand = (h: number): boolean => h > OCEAN_BELOW_M;

/**
 * Full-resolution height with one correction: off the US coast the USGS 3DEP
 * source covers land only, so open water comes out as exactly 0.0 m instead
 * of its depth. An exact 0 is therefore checked against the coarse tile,
 * which carries real bathymetry; if that says sea, the coarse depth wins.
 * (Real land at exactly 0.000 m next to the sea would be treated as sea,
 * which just means landing a few hundred metres further inland.)
 */
async function fineHeight(fine: HeightLookup, coarse: HeightLookup, lon: number, lat: number): Promise<number | undefined> {
  const h = await safe(fine, lon, lat);
  if (h !== 0) return h;
  const c = await safe(coarse, lon, lat);
  return c !== undefined && c <= OCEAN_BELOW_M ? c : h;
}

async function safe(lookup: HeightLookup, lon: number, lat: number): Promise<number | undefined> {
  try {
    const h = await lookup(lon, lat);
    return Number.isFinite(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Nearest dry ground to (lon, lat), or null if there's none within the
 * search radius (open ocean) or the tiles can't be fetched.
 */
export async function nearestLand(lon: number, lat: number, opts: NearestLandOptions = {}): Promise<LandHit | null> {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new RangeError('nearestLand: lon/lat must be finite');
  const fine = opts.fine ?? heightAt;
  const coarse = opts.coarse ?? coarseHeightAt;
  const maxR = opts.maxRadiusM ?? LAND_SEARCH_RADIUS_M;

  const here = await fineHeight(fine, coarse, lon, lat);
  if (here !== undefined && isLand(here)) return { lon, lat, height: here, distanceM: 0 };

  let inner = 0;
  for (const radius of LAND_SEARCH_RINGS_M) {
    if (radius > maxR) break;
    // Enough directions that neighbouring samples are <= ~2 km apart, 16..180.
    const n = Math.max(16, Math.min(180, Math.ceil((2 * Math.PI * radius) / 2_000)));
    const land: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = destinationPoint(lon, lat, (360 * i) / n, radius);
      const h = await safe(coarse, x, y);
      land.push(h !== undefined && isLand(h));
    }
    // Each run of land samples around the ring is a stretch of coast; the
    // middle of a run points most directly at it. Refine each (usually one or
    // two) and keep the closest.
    let best: LandHit | null = null;
    for (const bearing of landArcCentres(land)) {
      const hit = await refineShore(lon, lat, bearing, inner, radius, fine, coarse);
      if (hit && (!best || hit.distanceM < best.distanceM)) best = hit;
    }
    if (best) return best;
    inner = radius;
  }
  return null;
}

/**
 * Bearings (degrees) at the middle of each run of `true` in a ring of
 * samples, treating the ring as circular. A ring that's all land gives one
 * bearing (0). Exported for tests.
 */
export function landArcCentres(land: readonly boolean[]): number[] {
  const n = land.length;
  if (n === 0 || !land.includes(true)) return [];
  if (land.every(Boolean)) return [0];
  const start = land.indexOf(false); // begin just after a sea sample, so no run wraps
  const centres: number[] = [];
  let runStart = -1;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (land[i] && runStart < 0) runStart = k;
    if ((!land[i] || k === n) && runStart >= 0) {
      const runEnd = land[i] ? k : k - 1;
      const mid = (runStart + runEnd) / 2;
      centres.push(((((start + mid) % n) * 360) / n + 360) % 360);
      runStart = -1;
    }
  }
  return centres.slice(0, 6); // a ring through an archipelago: refine the first few only
}

/**
 * Along one bearing, find where sea turns to land between `inner` (sea) and
 * `outer` (land), step inland by the margin, and confirm at full resolution.
 */
async function refineShore(
  lon: number,
  lat: number,
  bearing: number,
  inner: number,
  outer: number,
  fine: HeightLookup,
  coarse: HeightLookup,
): Promise<LandHit | null> {
  let lo = inner;
  let hi = outer;
  // Bisect on coarse tiles down to ~2 km (no new downloads), then on full
  // resolution down to ~50 m (a handful of tiles near the coast).
  for (let i = 0; i < 24 && hi - lo > 50; i++) {
    const mid = (lo + hi) / 2;
    const [x, y] = destinationPoint(lon, lat, bearing, mid);
    const h = hi - lo > 2_000 ? await safe(coarse, x, y) : ((await fineHeight(fine, coarse, x, y)) ?? (await safe(coarse, x, y)));
    if (h !== undefined && isLand(h)) hi = mid;
    else lo = mid;
  }
  // Step inland, then a few more steps if the full-resolution check still says sea.
  for (let step = 0; step < 6; step++) {
    const d = hi + LAND_INLAND_MARGIN_M * (step + 1);
    const [x, y] = destinationPoint(lon, lat, bearing, d);
    const h = await fineHeight(fine, coarse, x, y);
    if (h !== undefined && isLand(h)) return { lon: x, lat: y, height: h, distanceM: d };
  }
  return null;
}

const coarseCache = createHeightCache(
  async (z, x, y) => {
    const image = fetchTileImage(z, x, y);
    if (!image) throw new Error(`terrain: could not request tile ${z}/${x}/${y}`);
    return imageToHeights(await image);
  },
  { zoom: LAND_SEARCH_ZOOM, cacheSize: 24 },
);

/** Height from coarse zoom-7 tiles (~1.2 km per pixel); for wide searches only. */
export function coarseHeightAt(lon: number, lat: number): Promise<number> {
  return coarseCache.heightAt(lon, lat);
}

export type LandingPlan =
  | { kind: 'land'; lon: number; lat: number; ground: number; movedM: number; place?: string }
  | { kind: 'ocean'; lon: number; lat: number; hoverHeightM: number }
  | { kind: 'unknown'; lon: number; lat: number };

/**
 * Where an arrival from space should end up:
 *   - 'land': the nearest dry ground (possibly the requested spot itself);
 *     in open ocean (no land within the search radius) the nearest
 *     POPULATED_LANDINGS city instead, with `place` set (Lumi: Cosmoscope's
 *     default Earth view put arrivals in the mid-Pacific, 24N 174E);
 *   - 'ocean': open sea and the fallback city couldn't be confirmed either;
 *     hover OCEAN_HOVER_HEIGHT_M above sea level at the requested spot,
 *     looking at the horizon;
 *   - 'unknown': the terrain at the spot couldn't be fetched, so we can't
 *     tell sea from mountain. Don't hover low; stay high and let the user
 *     search (a low hover could be inside a mountain).
 */
export async function planLanding(lon: number, lat: number, opts: NearestLandOptions = {}): Promise<LandingPlan> {
  const here = await safe(opts.fine ?? heightAt, lon, lat);
  if (here === undefined) return { kind: 'unknown', lon, lat };
  const hit = await nearestLand(lon, lat, opts);
  if (hit) return { kind: 'land', lon: hit.lon, lat: hit.lat, ground: hit.height, movedM: hit.distanceM };
  // Open ocean: go to the nearest big city instead of hovering over water.
  // Same nearestLand() check there (small radius), so a city point that reads
  // as water (harbour pixel) still snaps to its shore.
  const city = nearestPopulated(lon, lat);
  const there = await nearestLand(city.lon, city.lat, { ...opts, maxRadiusM: POPULATED_SNAP_RADIUS_M }).catch(() => null);
  if (there) {
    return {
      kind: 'land',
      lon: there.lon,
      lat: there.lat,
      ground: there.height,
      movedM: distanceM(lon, lat, there.lon, there.lat),
      place: city.name,
    };
  }
  return { kind: 'ocean', lon, lat, hoverHeightM: OCEAN_HOVER_HEIGHT_M };
}

// ---- open-ocean fallback (Lumi) ---------------------------------------------
// City-centre points on land, spread so every ocean has one within reach:
// Pacific islands (Honolulu, Suva, Papeete), both coasts of every ocean.

export interface PopulatedPlace {
  name: string;
  lon: number;
  lat: number;
}

/** How far around a fallback city nearestLand() may look, metres. */
export const POPULATED_SNAP_RADIUS_M = 20_000;

export const POPULATED_LANDINGS: readonly PopulatedPlace[] = [
  { name: 'New York', lon: -73.9855, lat: 40.758 },
  { name: 'Los Angeles', lon: -118.2437, lat: 34.0522 },
  { name: 'San Francisco', lon: -122.4193, lat: 37.7793 },
  { name: 'Seattle', lon: -122.3321, lat: 47.6062 },
  { name: 'Vancouver', lon: -123.1207, lat: 49.2827 },
  { name: 'Anchorage', lon: -149.9003, lat: 61.2181 },
  { name: 'Honolulu', lon: -157.8583, lat: 21.3069 },
  { name: 'Mexico City', lon: -99.1332, lat: 19.4326 },
  { name: 'Miami', lon: -80.1937, lat: 25.7743 },
  { name: 'Chicago', lon: -87.6298, lat: 41.8781 },
  { name: 'Toronto', lon: -79.3832, lat: 43.6532 },
  { name: 'Halifax', lon: -63.5752, lat: 44.6488 },
  { name: 'Reykjavik', lon: -21.9426, lat: 64.1466 },
  { name: 'London', lon: -0.1276, lat: 51.5072 },
  { name: 'Paris', lon: 2.3522, lat: 48.8566 },
  { name: 'Lisbon', lon: -9.1393, lat: 38.7223 },
  { name: 'Madrid', lon: -3.7038, lat: 40.4168 },
  { name: 'Rome', lon: 12.4964, lat: 41.9028 },
  { name: 'Berlin', lon: 13.405, lat: 52.52 },
  { name: 'Moscow', lon: 37.6173, lat: 55.7558 },
  { name: 'Istanbul', lon: 28.9784, lat: 41.0082 },
  { name: 'Cairo', lon: 31.2357, lat: 30.0444 },
  { name: 'Dakar', lon: -17.4677, lat: 14.7167 },
  { name: 'Lagos', lon: 3.3792, lat: 6.5244 },
  { name: 'Nairobi', lon: 36.8219, lat: -1.2921 },
  { name: 'Cape Town', lon: 18.4241, lat: -33.9249 },
  { name: 'Dubai', lon: 55.2708, lat: 25.2048 },
  { name: 'Mumbai', lon: 72.8777, lat: 19.076 },
  { name: 'Delhi', lon: 77.209, lat: 28.6139 },
  { name: 'Colombo', lon: 79.8612, lat: 6.9271 },
  { name: 'Bangkok', lon: 100.5018, lat: 13.7563 },
  { name: 'Singapore', lon: 103.8198, lat: 1.3521 },
  { name: 'Jakarta', lon: 106.8456, lat: -6.2088 },
  { name: 'Hong Kong', lon: 114.1694, lat: 22.3193 },
  { name: 'Manila', lon: 120.9842, lat: 14.5995 },
  { name: 'Shanghai', lon: 121.4737, lat: 31.2304 },
  { name: 'Beijing', lon: 116.4074, lat: 39.9042 },
  { name: 'Seoul', lon: 126.978, lat: 37.5665 },
  { name: 'Tokyo', lon: 139.6503, lat: 35.6762 },
  { name: 'Perth', lon: 115.8605, lat: -31.9505 },
  { name: 'Sydney', lon: 151.2093, lat: -33.8688 },
  { name: 'Auckland', lon: 174.7633, lat: -36.8485 },
  { name: 'Suva', lon: 178.4501, lat: -18.1248 },
  { name: 'Papeete', lon: -149.5585, lat: -17.5516 },
  { name: 'Lima', lon: -77.0428, lat: -12.0464 },
  { name: 'Santiago', lon: -70.6693, lat: -33.4489 },
  { name: 'Buenos Aires', lon: -58.3816, lat: -34.6037 },
  { name: 'Rio de Janeiro', lon: -43.1729, lat: -22.9068 },
  { name: 'Sao Paulo', lon: -46.6333, lat: -23.5505 },
  { name: 'Bogota', lon: -74.0721, lat: 4.711 },
];

/** Nearest POPULATED_LANDINGS entry to (lon, lat), by great-circle distance. */
export function nearestPopulated(lon: number, lat: number): PopulatedPlace & { distanceM: number } {
  let best = POPULATED_LANDINGS[0];
  let bestD = Infinity;
  for (const p of POPULATED_LANDINGS) {
    const d = distanceM(lon, lat, p.lon, p.lat);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { ...best, distanceM: bestD };
}
