import { describe, expect, it } from 'vitest';
import { calculateMoveOffset } from './walk';

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
