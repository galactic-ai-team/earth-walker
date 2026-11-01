// src/permalink.test.ts — lane 5 tests: permalink format/parse round-trips
// and rejection of malformed hashes. Pure: no network, no Cesium viewer.

import { describe, expect, it } from 'vitest';

import { formatPermalink, normalizeHeading, parsePermalink } from './permalink';

describe('formatPermalink', () => {
  it('formats the documented shape', () => {
    expect(formatPermalink({ lat: 40.7128, lon: -74.006, heightM: 2, headingDeg: 90 }))
      .toBe('#40.7128,-74.006,2,90');
  });

  it('keeps ~0.1 m precision and trims trailing zeros', () => {
    expect(formatPermalink({ lat: 46.020713, lon: 7.749117, heightM: 1.7, headingDeg: 225 }))
      .toBe('#46.020713,7.749117,1.7,225');
  });

  it('normalizes heading and clamps negative heights to 0', () => {
    expect(formatPermalink({ lat: 0, lon: 0, heightM: -5, headingDeg: 370 })).toBe('#0,0,0,10');
    expect(formatPermalink({ lat: 0, lon: 0, heightM: 0, headingDeg: -10 })).toBe('#0,0,0,350');
  });
});

describe('parsePermalink', () => {
  it('parses a valid hash', () => {
    expect(parsePermalink('#40.7128,-74.0060,2,90')).toEqual({
      lat: 40.7128,
      lon: -74.006,
      heightM: 2,
      headingDeg: 90,
    });
  });

  it('round-trips through formatPermalink', () => {
    const state = { lat: 40.741061, lon: -73.989699, heightM: 1.7, headingDeg: 30 };
    expect(parsePermalink(formatPermalink(state))).toEqual(state);
  });

  it('accepts a hash without the leading # and normalizes heading', () => {
    expect(parsePermalink('45.9763,7.6586,120,450')?.headingDeg).toBe(90);
  });

  it.each([
    '',
    '#',
    '#abc',
    '#40.7,-74.0,2', // too few fields
    '#40.7,-74.0,2,90,5', // too many fields
    '#40.7,-74.0,2,north', // non-numeric heading
    '#NaN,-74.0,2,90',
    '#91,-74.0,2,90', // lat out of range
    '#40.7,-181,2,90', // lon out of range
    '#40.7,-74.0,-1,90', // negative height
    '#40.7,-74.0,99999,90', // absurd height
  ])('rejects %j', (hash) => {
    expect(parsePermalink(hash)).toBeNull();
  });
});

describe('normalizeHeading', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeHeading(0)).toBe(0);
    expect(normalizeHeading(360)).toBe(0);
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(725)).toBe(5);
  });
});
