// src/search.test.ts — lane 5 tests: parsing, URL building, rate limiting
// and debouncing, all without network or real time (fake fetch/clock/timers).

import { describe, expect, it, vi } from 'vitest';

import {
  RateLimiter,
  buildNominatimUrl,
  debounce,
  parseNominatimResults,
  searchPlaces,
} from './search';

const RAW = [
  {
    place_id: 12345,
    display_name: 'Flatiron Building, 175, 5th Avenue, New York, NY, United States',
    lat: '40.741061',
    lon: '-73.989699',
    type: 'building',
    class: 'building',
  },
  {
    place_id: 67890,
    display_name: 'Zermatt, Visp, Valais, Switzerland',
    lat: '46.020713',
    lon: '7.749117',
    type: 'village',
    class: 'place',
  },
];

describe('parseNominatimResults', () => {
  it('converts string coordinates to numbers and keeps label/type/id', () => {
    const out = parseNominatimResults(RAW);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: '12345',
      label: RAW[0].display_name,
      lat: 40.741061,
      lon: -73.989699,
      type: 'building',
    });
    expect(out[1].lat).toBeCloseTo(46.020713);
    expect(out[1].lon).toBeCloseTo(7.749117);
  });

  it('falls back to class when type is missing, and to "lat,lon" when place_id is', () => {
    const out = parseNominatimResults([
      { display_name: 'Somewhere', lat: '1.5', lon: '2.5', class: 'place' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('place');
    expect(out[0].id).toBe('1.5,2.5');
  });

  it('drops entries with non-numeric coordinates or no name', () => {
    const out = parseNominatimResults([
      { place_id: 1, display_name: 'Bad coords', lat: 'north', lon: '-73.9' },
      { place_id: 2, display_name: '', lat: '40.7', lon: '-73.9' },
      { place_id: 3, lat: '40.7', lon: '-73.9' },
      null,
      'garbage',
      RAW[0],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe(RAW[0].display_name);
  });

  it('returns [] for non-array payloads', () => {
    expect(parseNominatimResults(null)).toEqual([]);
    expect(parseNominatimResults({})).toEqual([]);
    expect(parseNominatimResults('nope')).toEqual([]);
  });
});

describe('buildNominatimUrl', () => {
  it('targets Nominatim with jsonv2 and an encoded query', () => {
    const url = buildNominatimUrl('Flatiron Building, NYC', 5);
    expect(url.startsWith('https://nominatim.openstreetmap.org/search?')).toBe(true);
    expect(url).toContain('format=jsonv2');
    expect(url).toContain('limit=5');
    expect(url).toContain('q=Flatiron+Building%2C+NYC');
  });
});

describe('RateLimiter', () => {
  it('spaces concurrent waits at least the interval apart', async () => {
    let t = 0;
    const limiter = new RateLimiter(1000, () => t, async (ms) => { t += ms; });
    const resolvedAt: number[] = [];
    await Promise.all([0, 1, 2].map(() => limiter.wait().then(() => resolvedAt.push(t))));
    expect(resolvedAt).toEqual([0, 1000, 2000]);
  });

  it('does not wait again once the interval has passed', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(1000, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    await limiter.wait();
    t += 5000; // long idle gap
    await limiter.wait();
    expect(sleeps).toEqual([]);
  });
});

describe('searchPlaces (fake fetch, no network)', () => {
  const okFetch = (payload: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch;

  it('returns [] for an empty query without fetching', async () => {
    const fetchFn = okFetch(RAW);
    const out = await searchPlaces('   ', { fetchFn, limiter: new RateLimiter(0) });
    expect(out).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches the Nominatim URL and parses the results', async () => {
    const fetchFn = okFetch(RAW);
    const out = await searchPlaces('Zermatt', { fetchFn, limiter: new RateLimiter(0) });
    expect(out).toHaveLength(2);
    const calledUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('nominatim.openstreetmap.org');
    expect(calledUrl).toContain('q=Zermatt');
  });

  it('rejects on an HTTP error', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(searchPlaces('Zermatt', { fetchFn, limiter: new RateLimiter(0) }))
      .rejects.toThrow('HTTP 429');
  });
});

describe('debounce', () => {
  it('collapses rapid calls into one, with the last arguments', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 300);
      debounced('a');
      debounced('ab');
      vi.advanceTimersByTime(299);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('ab');
    } finally {
      vi.useRealTimers();
    }
  });
});
