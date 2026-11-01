// src/search.ts — earth-walker lane 5: place search + teleport (owner: Nova).
//
// Search is keyless Nominatim (OpenStreetMap), used inside its usage policy:
//   - at most 1 request/second, enforced by a shared RateLimiter below
//     (all searches queue through one instance, so tabs/widgets can't burst);
//   - 350 ms debounce + a 3-character minimum before anything is sent;
//   - no autocomplete scraping — one request per settled query, results are
//     shown verbatim from Nominatim's display_name.
// Browsers can't set a User-Agent header, so identification rides on the
// page Referer, which is Nominatim's accepted browser pattern.
//
// teleport() lands the camera at street level: Claude's heightAt(lon, lat)
// from lane 1's terrain pipeline, plus a 1.7 m eye height, flown to with
// Cesium's camera.flyTo. Same datum as the drawn terrain (see the datum
// note in terrain.ts), so feet-on-ground work by Gemini's walk controller
// starts from exactly where the camera lands.
//
// main.ts wiring (one line):  mountSearchBox(viewer);

import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium';

import { heightAt } from './terrain';
import type { CameraPreset } from './presets';

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
/** Nominatim usage policy: never more than one request per second. */
export const NOMINATIM_MIN_INTERVAL_MS = 1000;
export const SEARCH_DEBOUNCE_MS = 350;
export const MIN_QUERY_LENGTH = 3;
export const DEFAULT_RESULT_LIMIT = 8;
/** Standing eye height above the ground, metres. */
export const EYE_HEIGHT_M = 1.7;

// ---- result parsing (pure; unit-tested) --------------------------------------

export interface PlaceResult {
  /** Nominatim place_id when present, else a "lat,lon" fallback. */
  id: string;
  /** Verbatim Nominatim display_name. */
  label: string;
  lat: number;
  lon: number;
  /** Nominatim `type` (e.g. "building"), falling back to `class`. */
  type?: string;
}

/** Parse a raw Nominatim JSON payload, dropping anything malformed. */
export function parseNominatimResults(data: unknown): PlaceResult[] {
  if (!Array.isArray(data)) return [];
  const out: PlaceResult[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    const label = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
    if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const type =
      typeof raw.type === 'string' ? raw.type : typeof raw.class === 'string' ? raw.class : undefined;
    out.push({
      id: raw.place_id != null ? String(raw.place_id) : `${lat},${lon}`,
      label,
      lat,
      lon,
      type,
    });
  }
  return out;
}

export function buildNominatimUrl(query: string, limit = DEFAULT_RESULT_LIMIT): string {
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: String(limit),
    addressdetails: '0',
    dedupe: '1',
    q: query,
  });
  return `${NOMINATIM_ENDPOINT}?${params.toString()}`;
}

// ---- rate limiting (pure with injected clock; unit-tested) --------------------

/**
 * Serial spacing gate: wait() calls resolve one at a time, each at least
 * minIntervalMs after the previous one started its slot. Clock and sleep
 * are injectable so tests run without real time or network.
 */
export class RateLimiter {
  private lastSlot = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number = NOMINATIM_MIN_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  async wait(): Promise<void> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.lastSlot + this.minIntervalMs - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastSlot = this.now();
    } finally {
      release();
    }
  }
}

const sharedLimiter = new RateLimiter();

export interface SearchDeps {
  fetchFn?: typeof fetch;
  limiter?: RateLimiter;
  limit?: number;
}

/** One settled search: rate-limited, then parsed. Empty query = no request. */
export async function searchPlaces(query: string, deps: SearchDeps = {}): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];
  const limiter = deps.limiter ?? sharedLimiter;
  await limiter.wait();
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(buildNominatimUrl(q, deps.limit ?? DEFAULT_RESULT_LIMIT));
  if (!res.ok) throw new Error(`Nominatim search failed: HTTP ${res.status}`);
  return parseNominatimResults(await res.json());
}

// ---- debounce (unit-tested) ----------------------------------------------------

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

// ---- teleport --------------------------------------------------------------------

export interface TeleportOptions {
  /** Override for tests / alternate samplers. Defaults to terrain's heightAt. */
  heightAtFn?: (lon: number, lat: number) => Promise<number>;
  eyeHeightM?: number;
  headingDeg?: number;
  pitchDeg?: number;
  duration?: number;
}

/**
 * Fly to (lon, lat) and land at street level: ground height from heightAt()
 * plus eye height, near-level pitch so you arrive looking down the street.
 * Resolves when the flight completes or is cancelled by the user.
 */
export async function teleport(
  viewer: Viewer,
  lon: number,
  lat: number,
  opts: TeleportOptions = {},
): Promise<void> {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new RangeError(`teleport: lon/lat must be finite numbers (got ${lon}, ${lat})`);
  }
  const ground = await (opts.heightAtFn ?? heightAt)(lon, lat);
  const eye = ground + (opts.eyeHeightM ?? EYE_HEIGHT_M);
  return new Promise<void>((resolve) => {
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, eye),
      orientation: {
        heading: CesiumMath.toRadians(opts.headingDeg ?? 0),
        pitch: CesiumMath.toRadians(opts.pitchDeg ?? -3),
        roll: 0,
      },
      duration: opts.duration ?? 2.5,
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

// ---- extra presets (proposed additions to PRESETS in presets.ts) ---------------
// Heights follow presets.ts: absolute height above the ellipsoid, metres.

export const EXTRA_PRESETS: readonly CameraPreset[] = [
  { id: 'zermatt', label: 'Zermatt (Matterhorn view)', lat: 46.0207, lon: 7.7491, height: 1690, heading: 225, pitch: -8 },
  { id: 'forest-hills', label: 'Forest Hills, Queens', lat: 40.7209, lon: -73.8497, height: 250, heading: 90, pitch: -30 },
];

// ---- search box UI ---------------------------------------------------------------

/**
 * Build the search box (input + results list + status line) inside
 * `container` (default: document.body, absolutely positioned top-left).
 * Inline styles keep it working before lane 6 styles it properly.
 * Returns a handle with the element and a dispose() that removes it.
 */
export function mountSearchBox(
  viewer: Viewer,
  container: HTMLElement = document.body,
): { element: HTMLElement; dispose: () => void } {
  const root = document.createElement('div');
  root.style.cssText =
    'position:absolute;top:12px;left:12px;z-index:10;width:min(420px,80vw);' +
    'font-family:system-ui,sans-serif;color:#fff;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search the world… (place or address)';
  input.setAttribute('aria-label', 'Search the world');
  input.style.cssText =
    'width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;' +
    'border:1px solid rgba(255,255,255,0.35);background:rgba(10,14,20,0.82);color:#fff;font-size:14px;';

  const list = document.createElement('div');
  list.style.cssText =
    'margin-top:6px;border-radius:8px;overflow:hidden;background:rgba(10,14,20,0.92);display:none;';

  const status = document.createElement('div');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'margin-top:6px;font-size:12px;opacity:0.85;min-height:1em;';

  root.append(input, list, status);
  container.appendChild(root);

  const closeList = (): void => {
    list.replaceChildren();
    list.style.display = 'none';
  };

  const showMessage = (text: string): void => {
    closeList();
    const row = document.createElement('div');
    row.textContent = text;
    row.style.cssText = 'padding:9px 12px;font-size:13px;opacity:0.85;';
    list.appendChild(row);
    list.style.display = 'block';
  };

  const pick = (r: PlaceResult): void => {
    input.value = r.label;
    closeList();
    status.textContent = '';
    void teleport(viewer, r.lon, r.lat).catch(() => {
      status.textContent = 'Could not land there — terrain height unavailable.';
    });
  };

  const runSearch = async (q: string): Promise<void> => {
    status.textContent = 'Searching…';
    try {
      const results = await searchPlaces(q);
      if (input.value.trim() !== q) return; // a newer query superseded this one
      if (results.length === 0) {
        showMessage('No results — try a fuller address.');
        status.textContent = '';
        return;
      }
      closeList();
      for (const r of results) {
        const b = document.createElement('button');
        b.textContent = r.type ? `${r.label} · ${r.type}` : r.label;
        b.style.cssText =
          'display:block;width:100%;text-align:left;padding:9px 12px;font-size:13px;' +
          'background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,0.08);color:#fff;cursor:pointer;';
        b.addEventListener('click', () => pick(r));
        list.appendChild(b);
      }
      list.style.display = 'block';
      status.textContent = '';
    } catch {
      if (input.value.trim() !== q) return;
      showMessage('Search failed — check your connection and try again.');
      status.textContent = '';
    }
  };

  const debounced = debounce((q: string) => void runSearch(q), SEARCH_DEBOUNCE_MS);

  const onInput = (): void => {
    const q = input.value.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      closeList();
      status.textContent = q ? `Keep typing (${MIN_QUERY_LENGTH}+ characters)…` : '';
      return;
    }
    debounced(q);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeList();
    if (e.key === 'Enter') {
      const first = list.querySelector('button');
      if (first) first.click();
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);

  return {
    element: root,
    dispose: () => {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
