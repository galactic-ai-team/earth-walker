// src/spaceHandoff.test.ts — Cosmoscope handoff parsing (pure; no Cesium viewer).
import { describe, expect, it } from 'vitest';

import {
  BACK_TO_SPACE_URL,
  DESCENT_START_HEIGHT_M,
  descentStartPose,
  parseSpaceHandoff,
  strippedHandoffUrl,
} from './spaceHandoff';
import { parsePermalink } from './permalink';

describe('parseSpaceHandoff', () => {
  it('reads Cosmoscope\'s URL shape: marker + hour in the query, permalink in the hash', () => {
    const h = parseSpaceHandoff('?from=cosmoscope&hour=14.26', '#40.7128,-74.006,2,90');
    expect(h).toEqual({ fromCosmoscope: true, hour: 14.26, target: { lat: 40.7128, lon: -74.006, heightM: 2, headingDeg: 90 } });
  });

  it('is a plain permalink visit without the marker (hour ignored)', () => {
    const h = parseSpaceHandoff('?hour=3', '#46.02,7.75,2,0');
    expect(h.fromCosmoscope).toBe(false);
    expect(h.hour).toBeNull();
    expect(h.target).not.toBeNull();
    expect(parseSpaceHandoff('', '').fromCosmoscope).toBe(false);
  });

  it('drops bad hours and keeps a valid target', () => {
    for (const bad of ['', 'abc', '-1', '25', 'Infinity']) {
      expect(parseSpaceHandoff(`from=cosmoscope&hour=${bad}`, '#0,0,2,0').hour).toBeNull();
    }
    expect(parseSpaceHandoff('from=cosmoscope&hour=24', '#0,0,2,0').hour).toBe(0);
    expect(parseSpaceHandoff('from=cosmoscope', '#0,0,2,0').hour).toBeNull();
  });

  it('has no target when the hash is not a permalink (e.g. a stray &from in the hash)', () => {
    expect(parseSpaceHandoff('?from=cosmoscope', '#40,-74,2,90&from=cosmoscope').target).toBeNull();
    expect(parseSpaceHandoff('?from=cosmoscope', '').target).toBeNull();
  });
});

describe('strippedHandoffUrl', () => {
  it('removes from/hour, keeps other params and the permalink hash', () => {
    expect(strippedHandoffUrl('/', '?from=cosmoscope&hour=14.26', '#40.7128,-74.006,2,90')).toBe('/#40.7128,-74.006,2,90');
    expect(strippedHandoffUrl('/', '?debug=1&from=cosmoscope', '#1,2,2,0')).toBe('/?debug=1#1,2,2,0');
  });
  it('round-trips through the permalink parser', () => {
    const url = strippedHandoffUrl('/', '?from=cosmoscope&hour=9', '#23.397953,-166.381711,2,1');
    expect(parsePermalink(url.slice(url.indexOf('#')))).not.toBeNull();
  });
});

describe('descentStartPose', () => {
  it('starts in orbit straight above the spot, looking down, with the same heading', () => {
    const p = descentStartPose({ lat: 46.02, lon: 7.75, heightM: 2, headingDeg: 225 });
    expect(p).toEqual({ lat: 46.02, lon: 7.75, heightM: DESCENT_START_HEIGHT_M, headingDeg: 225, pitchDeg: -90 });
    expect(DESCENT_START_HEIGHT_M).toBeGreaterThan(20_000); // far above the permalink height cap
  });
});

describe('BACK_TO_SPACE_URL', () => {
  it('uses Cosmoscope\'s #to=<id> deep link for Earth', () => {
    const u = new URL(BACK_TO_SPACE_URL);
    expect(u.origin).toBe('https://cosmoscope-chi.vercel.app');
    expect(new URLSearchParams(u.hash.slice(1)).get('to')).toBe('planet:earth');
    // Cosmoscope's deepLink.ts ID_RE
    expect(/^[a-z]+:[a-z0-9_-]+(?::[^\s#&]+)?$/i.test('planet:earth')).toBe(true);
  });
});
