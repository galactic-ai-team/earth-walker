// src/nearestLand.test.ts — nearest dry ground for arrivals from space (owner: Claude).
// No network: synthetic height fields stand in for the terrain tiles.
import { describe, expect, it, vi } from 'vitest';

import {
  LAND_INLAND_MARGIN_M,
  OCEAN_BELOW_M,
  OCEAN_HOVER_HEIGHT_M,
  destinationPoint,
  distanceM,
  landArcCentres,
  nearestLand,
  planLanding,
  type HeightLookup,
} from './terrain';

const LON0 = -40; // mid-Atlantic-ish
const LAT0 = 30;

/** Sea everywhere except east of a north-south coastline `km` east of the origin. */
function coastEastOf(km: number, landHeight = 25): HeightLookup {
  const [coastLon] = destinationPoint(LON0, LAT0, 90, km * 1000);
  return async (lon) => (lon >= coastLon ? landHeight : -3000);
}

describe('destinationPoint / distanceM', () => {
  it('round-trip: going d metres on any bearing lands d metres away', () => {
    for (const bearing of [0, 45, 90, 200, 333]) {
      const [x, y] = destinationPoint(LON0, LAT0, bearing, 123_456);
      expect(distanceM(LON0, LAT0, x, y)).toBeCloseTo(123_456, 3);
    }
  });

  it('bearing 0 goes north and 90 goes east', () => {
    const [nx, ny] = destinationPoint(LON0, LAT0, 0, 10_000);
    expect(ny).toBeGreaterThan(LAT0);
    expect(nx).toBeCloseTo(LON0, 9);
    const [ex] = destinationPoint(LON0, LAT0, 90, 10_000);
    expect(ex).toBeGreaterThan(LON0);
  });
});

describe('landArcCentres', () => {
  const ring = (s: string) => [...s].map((c) => c === '#');

  it('finds the middle of each run of land, including runs that wrap past north', () => {
    expect(landArcCentres(ring('..###...'))).toEqual([135]); // samples 2-4 of 8, centre 3 -> 135 deg
    expect(landArcCentres(ring('##....##'))).toEqual([337.5]); // run 6,7,0,1 wraps; centre 7.5 -> 337.5
    expect(landArcCentres(ring('#..#....'))).toEqual([135, 0]); // two separate coasts
  });

  it('handles all-sea and all-land rings', () => {
    expect(landArcCentres(ring('........'))).toEqual([]);
    expect(landArcCentres(ring('########'))).toEqual([0]);
  });
});

describe('nearestLand', () => {
  it('keeps the spot when it is already land, without searching', async () => {
    const coarse = vi.fn(async () => -3000);
    const hit = await nearestLand(LON0, LAT0, { fine: async () => 120, coarse });
    expect(hit).toEqual({ lon: LON0, lat: LAT0, height: 120, distanceM: 0 });
    expect(coarse).not.toHaveBeenCalled();
  });

  it('treats polders (a few metres below sea level) as land', async () => {
    const hit = await nearestLand(4.9, 52.37, { fine: async () => -4, coarse: async () => -4 });
    expect(hit?.distanceM).toBe(0);
    expect(OCEAN_BELOW_M).toBeLessThan(-4);
  });

  it('finds a coast 30 km east and lands just inland of the shoreline', async () => {
    const field = coastEastOf(30);
    const hit = await nearestLand(LON0, LAT0, { fine: field, coarse: field });
    expect(hit).not.toBeNull();
    expect(hit!.height).toBe(25);
    expect(hit!.distanceM).toBeGreaterThan(30_000);
    expect(hit!.distanceM).toBeLessThan(30_000 + LAND_INLAND_MARGIN_M + 400);
    expect(hit!.lon).toBeGreaterThan(LON0); // went east
  });

  it('picks the nearer of two coasts', async () => {
    const [eastLon] = destinationPoint(LON0, LAT0, 90, 120_000);
    const [, northLat] = destinationPoint(LON0, LAT0, 0, 15_000);
    const field: HeightLookup = async (lon, lat) => (lon >= eastLon || lat >= northLat ? 10 : -2000);
    const hit = await nearestLand(LON0, LAT0, { fine: field, coarse: field });
    expect(hit!.lat).toBeGreaterThan(LAT0); // the northern coast, 15 km away
    expect(hit!.distanceM).toBeLessThan(16_000);
  });

  it('returns null in open ocean (nothing within the search radius)', async () => {
    const sea: HeightLookup = async () => -4000;
    expect(await nearestLand(LON0, LAT0, { fine: sea, coarse: sea })).toBeNull();
  });

  it('respects a smaller search radius', async () => {
    const field = coastEastOf(100);
    expect(await nearestLand(LON0, LAT0, { fine: field, coarse: field, maxRadiusM: 50_000 })).toBeNull();
  });

  it('treats failed tile fetches as unknown, not as land', async () => {
    const failing: HeightLookup = async () => {
      throw new Error('offline');
    };
    expect(await nearestLand(LON0, LAT0, { fine: failing, coarse: failing })).toBeNull();
  });

  it('confirms with full resolution: steps further inland if the fine tiles still say sea', async () => {
    // Coarse tiles put the coast at 20 km; the real (fine) coast is 400 m further out.
    const coarse = coastEastOf(20);
    const fine = coastEastOf(20.4);
    const hit = await nearestLand(LON0, LAT0, { fine, coarse });
    expect(hit).not.toBeNull();
    expect(await fine(hit!.lon, hit!.lat)).toBeGreaterThan(OCEAN_BELOW_M);
  });

  it('rejects non-finite input', async () => {
    await expect(nearestLand(Number.NaN, 0)).rejects.toThrow(RangeError);
  });
});

describe('planLanding', () => {
  it('lands on the nearest coast when there is one', async () => {
    const field = coastEastOf(10);
    const plan = await planLanding(LON0, LAT0, { fine: field, coarse: field });
    expect(plan.kind).toBe('land');
    if (plan.kind === 'land') {
      expect(plan.ground).toBe(25);
      expect(plan.movedM).toBeGreaterThan(10_000);
    }
  });

  it("says 'unknown' (not ocean) when the spot's terrain can't be fetched", async () => {
    const failing: HeightLookup = async () => {
      throw new Error('offline');
    };
    expect(await planLanding(LON0, LAT0, { fine: failing, coarse: failing })).toEqual({ kind: 'unknown', lon: LON0, lat: LAT0 });
  });

  it('hovers above the requested spot in open ocean', async () => {
    const sea: HeightLookup = async () => -4000;
    expect(await planLanding(LON0, LAT0, { fine: sea, coarse: sea })).toEqual({
      kind: 'ocean',
      lon: LON0,
      lat: LAT0,
      hoverHeightM: OCEAN_HOVER_HEIGHT_M,
    });
  });
});
