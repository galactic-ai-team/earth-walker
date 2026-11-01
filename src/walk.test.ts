import { describe, expect, it } from 'vitest';
import { calculateMoveOffset, resolveStep } from './walk';

describe('Walk Controller Movement Math', () => {
  it('moves north when heading is 0 and forward is positive', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = 0; // Facing North
    const forward = 1;
    const right = 0;
    const distance = 111320; // Exactly 1 degree of latitude north at equator

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(0, 4);
    expect(result.lat).toBeCloseTo(1, 2);
  });

  it('moves east when heading is pi/2 and forward is positive', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = Math.PI / 2; // Facing East
    const forward = 1;
    const right = 0;
    const distance = 111320; // 1 degree of longitude east at equator

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(1, 2);
    expect(result.lat).toBeCloseTo(0, 4);
  });


  it('does not change position when forward and right are 0', () => {
    const startLon = -74.006;
    const startLat = 40.7128;
    const heading = 1.23;
    const forward = 0;
    const right = 0;
    const distance = 50;

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBe(startLon);
    expect(result.lat).toBe(startLat);
  });
});

describe('Walk Controller strafing', () => {
  it('strafes east when facing north and pressing right', () => {
    const r = calculateMoveOffset(0, 0, 0, 0, 1, 111320);
    expect(r.lon).toBeCloseTo(1, 2);
    expect(r.lat).toBeCloseTo(0, 4);
  });

  it('strafes south when facing east and pressing right', () => {
    const r = calculateMoveOffset(0, 0, Math.PI / 2, 0, 1, 111320);
    expect(r.lat).toBeCloseTo(-1, 2);
    expect(r.lon).toBeCloseTo(0, 4);
  });
});

describe('resolveStep (ground, slopes, unloaded terrain, sliding)', () => {
  const M = 1 / 111320; // ~1 metre in degrees at the equator
  const rules = { maxSlopeDeg: 40, probeDistance: 1.5 };

  const flat = () => 100;

  it('walks on flat ground and follows it', () => {
    const s = resolveStep({ lon: 0, lat: 0, ground: 100 }, 0, 0.1 * M, flat, rules);
    expect(s.lat).toBeCloseTo(0.1 * M, 12);
    expect(s.ground).toBe(100);
  });

  it('refuses an uphill slope steeper than the limit, even in tiny per-frame steps', () => {
    // 60 degree slope rising to the north: height = 100 + tan(60) * metres north.
    const steep = (_lon: number, lat: number) => 100 + Math.tan((60 * Math.PI) / 180) * (lat / M);
    const from = { lon: 0, lat: 0, ground: 100 };
    const s = resolveStep(from, 0, 0.08 * M, steep, rules); // ~one frame at 5 m/s
    expect(s.lat).toBe(0);
    expect(s.ground).toBe(100);
  });

  it('allows a walkable uphill slope and any downhill', () => {
    const gentle = (_lon: number, lat: number) => 100 + Math.tan((20 * Math.PI) / 180) * (lat / M);
    expect(resolveStep({ lon: 0, lat: 0, ground: 100 }, 0, 0.08 * M, gentle, rules).lat).toBeCloseTo(0.08 * M, 12);
    const cliffDown = (_lon: number, lat: number) => (lat > 0 ? 20 : 100);
    const s = resolveStep({ lon: 0, lat: 0, ground: 100 }, 0, 0.08 * M, cliffDown, rules);
    expect(s.ground).toBe(20);
  });

  it('waits instead of dropping when the next ground has not loaded', () => {
    const unloadedAhead = (_lon: number, lat: number) => (lat > 0 ? undefined : 2500);
    const s = resolveStep({ lon: 0, lat: 0, ground: 2500 }, 0, 0.1 * M, unloadedAhead, rules);
    expect(s).toEqual({ lon: 0, lat: 0, ground: 2500 });
  });

  it('keeps the last known ground if nothing is loaded at all', () => {

    const s = resolveStep({ lon: 0, lat: 0, ground: 3100 }, 0.1 * M, 0.1 * M, () => undefined, rules);
    expect(s.ground).toBe(3100);
  });

  it('slides along a wall instead of stopping dead', () => {
    const wallNorth = (_lon: number, lat: number) => lat > 0.05 * M; // blocked north of a line
    const s = resolveStep({ lon: 0, lat: 0, ground: 10 }, 0.1 * M, 0.1 * M, () => 10, { ...rules, isBlocked: wallNorth });
    expect(s.lon).toBeCloseTo(0.1 * M, 12); // kept the east component
    expect(s.lat).toBe(0);
  });
});
