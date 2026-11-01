import { describe, expect, it } from 'vitest';
import {
  EOX,
  IMAGERY_SOURCES,
  NYS,
  SWISSTOPO,
  USGS,
  bboxContains,
  createProvider,
  sourcesCovering,
} from './imagery';
import { PRESETS } from './presets';

const NYC = { lon: -73.9897, lat: 40.7411 }; // Flatiron, the 'nyc' preset
const ZERMATT = { lon: 7.7491, lat: 46.0207 };
const DENVER = { lon: -104.99, lat: 39.74 };
const LONDON = { lon: -0.1276, lat: 51.5072 };

describe('imagery sources', () => {
  it('stacks EOX first as the global fallback, then the regional layers', () => {
    expect(IMAGERY_SOURCES.map((s) => s.id)).toEqual(['eox', 'usgs', 'nys', 'swisstopo']);
    expect(EOX.bbox).toBeUndefined();
    for (const s of IMAGERY_SOURCES.slice(1)) expect(s.bbox).toBeDefined();
  });

  it('uses keyless https templates with the right placeholders', () => {
    for (const s of IMAGERY_SOURCES) {
      expect(s.url.startsWith('https://')).toBe(true);
      expect(s.url).not.toMatch(/key|token|access_token/i);
      expect(s.credit.length).toBeGreaterThan(0);
      expect(s.license.length).toBeGreaterThan(0);
    }
    expect(EOX.url).toContain('/{z}/{y}/{x}.jpg');
    expect(USGS.url).toContain('/tile/{z}/{y}/{x}');
    expect(SWISSTOPO.url).toContain('/3857/{z}/{x}/{y}.jpeg');
    expect(NYS.url).toContain('bbox={westProjected},{southProjected},{eastProjected},{northProjected}');
    expect(NYS.url).toContain('format=jpgpng');
    expect(SWISSTOPO.credit).toContain('© swisstopo');
  });

  it('caps levels at what the servers actually serve', () => {
    expect(EOX.maximumLevel).toBe(15);
    expect(USGS.maximumLevel).toBe(16);
    expect(NYS.maximumLevel).toBe(19);
    expect(SWISSTOPO.maximumLevel).toBe(20);
    expect(NYS.minimumTerrainLevel).toBeGreaterThanOrEqual(12);
  });

  it('builds Cesium providers with clipped rectangles', () => {
    for (const s of IMAGERY_SOURCES) {
      const p = createProvider(s);
      expect(p.maximumLevel).toBe(s.maximumLevel);
      if (s.bbox) {
        expect((p.rectangle.west * 180) / Math.PI).toBeCloseTo(s.bbox.west, 6);
        expect((p.rectangle.north * 180) / Math.PI).toBeCloseTo(s.bbox.north, 6);
      }
    }
  });
});

describe('coverage', () => {
  it('NYC gets EOX + USGS + NYS orthos, not swisstopo', () => {
    expect(sourcesCovering(NYC.lon, NYC.lat)).toEqual(['eox', 'usgs', 'nys']);
  });

  it('Zermatt and the Alps preset get swisstopo, not the US layers', () => {
    expect(sourcesCovering(ZERMATT.lon, ZERMATT.lat)).toEqual(['eox', 'swisstopo']);
    const alps = PRESETS.find((p) => p.id === 'alps')!;
    expect(sourcesCovering(alps.lon, alps.lat)).toEqual(['eox', 'swisstopo']);
    const nyc = PRESETS.find((p) => p.id === 'nyc')!;
    expect(sourcesCovering(nyc.lon, nyc.lat)).toContain('nys');
  });

  it('elsewhere falls back correctly', () => {
    expect(sourcesCovering(DENVER.lon, DENVER.lat)).toEqual(['eox', 'usgs']);
    expect(sourcesCovering(LONDON.lon, LONDON.lat)).toEqual(['eox']);
    expect(bboxContains(undefined, 179, -89)).toBe(true);
  });
});
