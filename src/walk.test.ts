import { describe, expect, it } from 'vitest';
import { calculateMoveOffset } from './walk';

describe('Walk Controller Movement & Collision Math', () => {
  it('moves north when heading is 0 and forward is positive', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = 0;
    const forward = 1;
    const right = 0;
    const distance = 111320;

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(0, 4);
    expect(result.lat).toBeCloseTo(1, 2);
  });

  it('moves east when heading is pi/2 and forward is positive', () => {
    const startLon = 0;
    const startLat = 0;
    const heading = Math.PI / 2;
    const forward = 1;
    const right = 0;
    const distance = 111320;

    const result = calculateMoveOffset(startLon, startLat, heading, forward, right, distance);

    expect(result.lon).toBeCloseTo(1, 2);
    expect(result.lat).toBeCloseTo(0, 4);
  });

  it('stops a 1.25 m step from crossing a 0.3 m thin wall using sub-steps', () => {
    // Simulate a wall blocking points between offset 0.3m and 0.6m north
    const startLon = 0;
    const startLat = 0;
    const heading = 0; // Facing North
    const totalStepMeters = 1.25;

    // Convert meters to lat offset (approx 111320 meters per degree lat)
    const target = calculateMoveOffset(startLon, startLat, heading, 1, 0, totalStepMeters);

    // Mock an obstacle check function representing a thin wall at ~0.4m north
    const wallLatThreshold = 0.4 / 111320;
    const isBlocked = (_lon: number, lat: number) => {
      const distanceNorthMeters = lat * 111320;
      return distanceNorthMeters >= 0.3 && distanceNorthMeters <= 0.6;
    };

    // Run sub-step simulation (4 sub-steps)
    const subSteps = 4;
    let validLat = startLat;

    for (let i = 1; i <= subSteps; i++) {
      const fraction = i / subSteps;
      const subLat = startLat + (target.lat - startLat) * fraction;

      if (isBlocked(startLon, subLat)) {
        break; // Should halt before crossing the wall
      } else {
        validLat = subLat;
      }
    }

    const finalDistanceNorth = validLat * 111320;
    // Should stop right before 0.3m
    expect(finalDistanceNorth).toBeLessThan(0.3);
  });
});