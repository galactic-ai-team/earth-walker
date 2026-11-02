import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHASE,
  chaseOffset,
  clearTerrain,
  nextViewMode,
  offsetDegrees,
  orbitElevation,
  pullInDistance,
  smoothFactor,
} from './chaseCam';

describe('chase camera math', () => {
  it('sits behind the heading: facing north puts the camera south', () => {
    const o = chaseOffset(0, 0, 5);
    expect(o.north).toBeCloseTo(-5);
    expect(o.east).toBeCloseTo(0);
    expect(o.up).toBeCloseTo(0);
  });

  it('facing east puts the camera west, and elevation lifts it', () => {
    const o = chaseOffset(Math.PI / 2, 0.2, 5);
    expect(o.east).toBeCloseTo(-5 * Math.cos(0.2));
    expect(o.north).toBeCloseTo(0);
    expect(o.up).toBeCloseTo(5 * Math.sin(0.2));
  });

  it('default rig is ~6 m back and ~3-3.6 m above the feet', () => {
    const e = orbitElevation(0);
    const o = chaseOffset(0, e, DEFAULT_CHASE.distance);
    expect(-o.north).toBeGreaterThan(5);
    expect(-o.north).toBeLessThan(7);
    const above = DEFAULT_CHASE.pivotHeight + o.up;
    expect(above).toBeGreaterThan(3);
    expect(above).toBeLessThan(3.6);
  });

  it('looking down raises the orbit, looking up lowers it, both clamped', () => {
    expect(orbitElevation(-0.5)).toBeGreaterThan(orbitElevation(0));
    expect(orbitElevation(0.1)).toBeLessThan(orbitElevation(0));
    expect(orbitElevation(-10)).toBe(DEFAULT_CHASE.maxElevation);
    expect(orbitElevation(10)).toBe(DEFAULT_CHASE.minElevation);
  });

  it('raises the camera above terrain that is higher than it', () => {
    expect(clearTerrain(100, 101, 0.5)).toBe(101.5);
    expect(clearTerrain(100, 90, 0.5)).toBe(100);
    expect(clearTerrain(100, undefined, 0.5)).toBe(100);
  });

  it('pulls in just short of a building and never closer than the minimum', () => {
    expect(pullInDistance(() => true, 5, 0.8)).toBe(5);
    expect(pullInDistance((d) => d < 3, 5, 0.8)).toBeCloseTo(2.7);
    expect(pullInDistance(() => false, 5, 0.8)).toBe(0.8);
  });

  it('smoothing is frame-rate independent', () => {
    const one = smoothFactor(1 / 30, 0.1);
    const twoHalves = 1 - (1 - smoothFactor(1 / 60, 0.1)) ** 2;
    expect(one).toBeCloseTo(twoHalves, 10);
    expect(smoothFactor(0.016, 0)).toBe(1);
    expect(smoothFactor(0, 0.1)).toBe(0);
  });

  it('converts metres to degrees', () => {
    const d = offsetDegrees(0, 111320, 111320);
    expect(d.dLat).toBeCloseTo(1);
    expect(d.dLon).toBeCloseTo(1);
    expect(offsetDegrees(60, 111320, 0).dLon).toBeCloseTo(2, 5);
  });

  it('V toggles third <-> first person', () => {
    expect(nextViewMode('third')).toBe('first');
    expect(nextViewMode('first')).toBe('third');
    expect(nextViewMode(nextViewMode('third'))).toBe('third');
  });
});
