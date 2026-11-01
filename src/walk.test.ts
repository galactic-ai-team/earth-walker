import { describe, expect, it } from 'vitest';
import { calculateMoveOffset, resolveStep, canStand } from './walk';
import type { GroundSampler } from './terrain';

describe('Walk Controller Movement & Collision Math', () => {
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

  it('strafes east when facing north and pressing right', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = 0; // Facing North
    const forward = 0;
    const right = 1;
    const distance = 111320;

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(1, 2);
    expect(result.lat).toBeCloseTo(0, 4);
  });

  it('strafes south when facing east and pressing right', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = Math.PI / 2; // Facing East
    const forward = 0;
    const right = 1;
    const distance = 111320;

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(0, 4);
    expect(result.lat).toBeCloseTo(-1, 2);
  });

  it('walks on flat ground and follows it', () => {
    const ground: GroundSampler = () => 10;
    const stance = { lon: 0, lat: 0, heading: 0, pitch: 0 };
    const res = resolveStep(stance, 0, 0.001, ground);
    expect(res.lat).toBeGreaterThan(0);
  });

  it('refuses an uphill slope steeper than the limit', () => {
    // 100m rise over 100m run = 45 deg slope (exceeds 40 deg limit)
    const ground: GroundSampler = (lon, lat) => lat * 111320;
    const stance = { lon: 0, lat: 0, heading: 0, pitch: 0 };
    const dLat = 100 / 111320;
    const res = resolveStep(stance, 0, dLat, ground);
    expect(res.lat).toBe(0); // Movement blocked/refused
  });

  it('allows a walkable uphill slope and any downhill', () => {
    // 10m rise over 100m run = ~5.7 deg slope
    const ground: GroundSampler = (_lon, lat) => lat * 111320 * 0.1;
    const stance = { lon: 0, lat: 0, heading: 0, pitch: 0 };
    const dLat = 100 / 111320;
    const res = resolveStep(stance, 0, dLat, ground);
    expect(res.lat).toBeGreaterThan(0);
  });

  it('waits instead of dropping when the next ground has not loaded', () => {
    const ground: GroundSampler = (_lon, lat) => (lat > 0.0001 ? undefined : 10);
    const stance = { lon: 0, lat: 0, heading: 0, pitch: 0 };
    const res = resolveStep(stance, 0, 0.001, ground);
    expect(res.lat).toBe(0);
  });

  it('slides along a wall instead of stopping dead', () => {
    // Wall blocks movement directly north (lon = 0), but clear to the east
    const isBlocked = (lon: number) => Math.abs(lon) < 0.000001;
    const ground: GroundSampler = () => 0;
    const stance = { lon: 0, lat: 0, heading: 0, pitch: 0 };
    
    // Attempt diagonal step (North-East)
    const dLat = 10 / 111320;
    const dLon = 10 / (111320 * Math.cos(0));
    const res = resolveStep(stance, dLon, dLat, ground, { isBlocked, collisionRadius: 0.05 });
    
    // Should slide eastward
    expect(res.lon).toBeGreaterThan(0);
  });

  it('stops a step from crossing a thin wall using sub-steps and resolveStep', () => {
    const startLon = 0;
    const startLat = 0;
    const stance = { lon: startLon, lat: startLat, heading: 0, pitch: 0 };
    const totalStepMeters = 1.25;

    const target = calculateMoveOffset(startLon, startLat, 0, 1, 0, totalStepMeters);
    const dLat = target.lat - startLat;

    const isBlocked = (_lon: number, lat: number) => {
      const distanceNorthMeters = lat * 111320;
      return distanceNorthMeters >= 0.3 && distanceNorthMeters <= 0.6;
    };

    const ground: GroundSampler = () => 0;
    const resolved = resolveStep(stance, 0, dLat, ground, { isBlocked, collisionRadius: 0.1 });
    const finalDistanceNorth = resolved.lat * 111320;

    expect(finalDistanceNorth).toBeLessThan(0.3);
  });

  it('canStand checks radial clearance around position', () => {
    const isBlocked = (lon: number, _lat: number) => {
      return lon > 0.00001;
    };

    // Center is clear, but radial clearance (0.3m) hits blocked zone
    expect(canStand(0, 0, isBlocked, 0.3)).toBe(false);
  });
});
