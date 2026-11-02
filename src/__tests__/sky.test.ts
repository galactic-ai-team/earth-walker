// src/__tests__/sky.test.ts
// Unit tests for the pure hour->fog / hour->atmosphere functions in sky.ts.
// These run without a Viewer, no Cesium setup needed.

import { describe, expect, it } from 'vitest';
import {
  atmosphereBrightnessForHour,
  atmosphereHueForHour,
  atmosphereSaturationForHour,
  fogColorForHour,
  fogDensityForHour,
} from '../sky';

describe('fogDensityForHour', () => {
  it('is lowest at noon, highest near dawn/dusk', () => {
    const noon = fogDensityForHour(12);
    const dawn = fogDensityForHour(6);
    const dusk = fogDensityForHour(18);
    expect(dawn).toBeGreaterThan(noon);
    expect(dusk).toBeGreaterThan(noon);
    // Dawn and dusk are symmetric around noon by construction.
    expect(Math.abs(dawn - dusk)).toBeLessThan(1e-9);
  });

  it('is thicker at night than at noon', () => {
    expect(fogDensityForHour(0)).toBeGreaterThan(fogDensityForHour(12));
    expect(fogDensityForHour(23)).toBeGreaterThan(fogDensityForHour(12));
  });

  it('wraps hour correctly (0 == 24)', () => {
    expect(fogDensityForHour(0)).toBeCloseTo(fogDensityForHour(24), 12);
    expect(fogDensityForHour(-1)).toBeCloseTo(fogDensityForHour(23), 12);
  });
});

describe('atmosphereHueForHour', () => {
  it('is ~0 at noon and at midnight', () => {
    expect(atmosphereHueForHour(12)).toBeLessThan(0.005);
    expect(atmosphereHueForHour(0)).toBeLessThan(0.01);
    expect(atmosphereHueForHour(24)).toBeLessThan(0.01);
  });

  it('peaks near dawn and dusk', () => {
    const dawn = atmosphereHueForHour(6);
    const dusk = atmosphereHueForHour(18);
    expect(dawn).toBeGreaterThan(0.05);
    expect(dusk).toBeGreaterThan(0.05);
    expect(Math.abs(dawn - dusk)).toBeLessThan(1e-9);
  });
});

describe('fogColorForHour', () => {
  it('returns a color with alpha in (0, 1] at every hour', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const c = fogColorForHour(h);
      expect(c.alpha).toBeGreaterThan(0);
      expect(c.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('is warm at dawn (red > blue), blue at noon (blue > red)', () => {
    const dawn = fogColorForHour(7);
    const noon = fogColorForHour(12);
    expect(dawn.red).toBeGreaterThan(dawn.blue);
    expect(noon.blue).toBeGreaterThan(noon.red);
  });
});

describe('atmosphereHueForHour', () => {
  it('is ~0 at noon and midnight, peaks near dawn/dusk', () => {
    expect(atmosphereHueForHour(12)).toBeLessThan(0.005);
    expect(atmosphereHueForHour(0)).toBeLessThan(0.01);
    expect(atmosphereHueForHour(6)).toBeGreaterThan(0.08);
    expect(atmosphereHueForHour(18)).toBeGreaterThan(0.08);
  });

  it('is symmetric around noon', () => {
    expect(atmosphereHueForHour(6)).toBeCloseTo(atmosphereHueForHour(18), 9);
    expect(atmosphereHueForHour(7)).toBeCloseTo(atmosphereHueForHour(17), 9);
  });
});

describe('atmosphereSaturationForHour', () => {
  it('peaks at dawn/dusk, neutral at noon', () => {
    expect(atmosphereSaturationForHour(12)).toBeLessThan(0.01);
    expect(atmosphereSaturationForHour(6)).toBeGreaterThan(0.12);
    expect(atmosphereSaturationForHour(18)).toBeGreaterThan(0.12);
  });
});

describe('atmosphereBrightnessForHour', () => {
  it('dips at dawn/dusk, neutral at noon', () => {
    expect(atmosphereBrightnessForHour(12)).toBeGreaterThan(-0.01);
    expect(atmosphereBrightnessForHour(6)).toBeLessThan(-0.06);
    expect(atmosphereBrightnessForHour(18)).toBeLessThan(-0.06);
  });
});
