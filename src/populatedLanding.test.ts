// src/populatedLanding.test.ts — open-ocean arrivals land in the nearest big city (Lumi).
import { describe, expect, it } from 'vitest';

import {
  OCEAN_HOVER_HEIGHT_M,
  POPULATED_LANDINGS,
  distanceM,
  nearestPopulated,
  planLanding,
  type HeightLookup,
} from './terrain';

/** Sea everywhere except within `km` of a city point. */
function landOnlyNear(lon0: number, lat0: number, km = 5, height = 12): HeightLookup {
  return async (lon, lat) => (distanceM(lon, lat, lon0, lat0) <= km * 1000 ? height : -4000);
}

describe('nearestPopulated', () => {
  it("Cosmoscope's default Earth view (mid-Pacific, 24N 174E) picks Honolulu", () => {
    const c = nearestPopulated(174, 24);
    expect(c.name).toBe('Honolulu');
    expect(c.distanceM).toBeGreaterThan(2_500_000); // ~2,900 km
    expect(c.distanceM).toBeLessThan(3_200_000);
  });

  it('crosses the antimeridian (178.9W is next to Suva at 178.5E)', () => {
    expect(nearestPopulated(-178.9, -18).name).toBe('Suva');
  });

  it('mid-Atlantic picks a city on a nearby coast, not one across the globe', () => {
    const c = nearestPopulated(-40, 30);
    expect(c.distanceM).toBeLessThan(3_500_000);
  });

  it('every city is its own nearest', () => {
    for (const p of POPULATED_LANDINGS) expect(nearestPopulated(p.lon, p.lat).name).toBe(p.name);
  });
});

describe('planLanding open-ocean fallback', () => {
  it('mid-Pacific with no land in range lands in Honolulu', async () => {
    const hnl = POPULATED_LANDINGS.find((p) => p.name === 'Honolulu')!;
    const field = landOnlyNear(hnl.lon, hnl.lat);
    const plan = await planLanding(174, 24, { fine: field, coarse: field });
    expect(plan.kind).toBe('land');
    if (plan.kind === 'land') {
      expect(plan.place).toBe('Honolulu');
      expect(plan.ground).toBe(12);
      expect(distanceM(plan.lon, plan.lat, hnl.lon, hnl.lat)).toBeLessThan(1);
      expect(plan.movedM).toBeGreaterThan(1_500_000);
    }
  });

  it('a city point that reads as water snaps to its shore (same coast snap)', async () => {
    const hnl = POPULATED_LANDINGS.find((p) => p.name === 'Honolulu')!;
    // land only 3-8 km from the city point
    const field: HeightLookup = async (lon, lat) => {
      const d = distanceM(lon, lat, hnl.lon, hnl.lat);
      return d >= 3_000 && d <= 8_000 ? 20 : -50;
    };
    const plan = await planLanding(174, 24, { fine: field, coarse: field });
    expect(plan.kind).toBe('land');
    if (plan.kind === 'land') {
      expect(plan.place).toBe('Honolulu');
      const d = distanceM(plan.lon, plan.lat, hnl.lon, hnl.lat);
      expect(d).toBeGreaterThanOrEqual(3_000);
      expect(d).toBeLessThanOrEqual(8_000);
    }
  });

  it('a coast within the search radius still wins over the city (no place set)', async () => {
    const field = landOnlyNear(174.5, 24, 30);
    const plan = await planLanding(174, 24, { fine: field, coarse: field });
    expect(plan.kind).toBe('land');
    if (plan.kind === 'land') expect(plan.place).toBeUndefined();
  });

  it('still hovers at the spot when the fallback city can\'t be confirmed either', async () => {
    const sea: HeightLookup = async () => -4000;
    expect(await planLanding(174, 24, { fine: sea, coarse: sea })).toEqual({
      kind: 'ocean',
      lon: 174,
      lat: 24,
      hoverHeightM: OCEAN_HOVER_HEIGHT_M,
    });
  });
});
