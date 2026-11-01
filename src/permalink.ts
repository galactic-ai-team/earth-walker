// src/permalink.ts — earth-walker lane 5: shareable location permalinks
// (owner: Nova).
//
// The URL hash carries where you're standing:
//   #<lat>,<lon>,<heightM>,<headingDeg>     e.g. #40.7128,-74.0060,2,90
// heightM is metres ABOVE GROUND (2 ≈ standing eye height), not above the
// ellipsoid, so a link round-trips at street level anywhere on Earth.
// Heading is degrees clockwise from north; pitch is not stored (teleport's
// street-level -3° is used on arrival).
//
// Writer: on camera moveEnd, the camera's position is converted to
// lat/lon, its height above the ground is sampled from lane 1's terrain,
// and history.replaceState updates the hash (no history spam). Reader: on
// page load, a valid hash teleports there instead of any default view —
// so a user can bookmark their own block without the team ever storing
// their address.
//
// Ground heights go through groundHeightM(): it uses Claude's tryHeightAt
// (non-throwing, PR #5) when that export exists and falls back to the
// throwing heightAt otherwise, returning undefined when terrain is
// unavailable. The namespace access is deliberate: a hard named import of
// tryHeightAt would fail typecheck until PR #5 lands.

import { Math as CesiumMath, type Viewer } from 'cesium';

import * as terrain from './terrain';
import { teleport } from './search';

export interface PermalinkState {
  lat: number;
  lon: number;
  /** Metres above the ground at (lat, lon). */
  heightM: number;
  /** Degrees clockwise from north, normalized to [0, 360). */
  headingDeg: number;
}

type TryHeightAtFn = (lon: number, lat: number) => Promise<number | undefined>;

const tryHeightAt: TryHeightAtFn | undefined = (
  terrain as { tryHeightAt?: TryHeightAtFn }
).tryHeightAt;

/** Ground height in metres, or undefined when terrain can't be sampled. */
export async function groundHeightM(lon: number, lat: number): Promise<number | undefined> {
  if (tryHeightAt) {
    try {
      return await tryHeightAt(lon, lat);
    } catch {
      return undefined;
    }
  }
  try {
    return await terrain.heightAt(lon, lat);
  } catch {
    return undefined;
  }
}

// ---- format / parse (pure; unit-tested) ---------------------------------------

function trimFixed(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** State -> "#lat,lon,heightM,heading" (lat/lon to ~0.1 m precision). */
export function formatPermalink(state: PermalinkState): string {
  const lat = trimFixed(state.lat, 6);
  const lon = trimFixed(state.lon, 6);
  const height = trimFixed(Math.max(0, state.heightM), 1);
  const heading = String(Math.round(normalizeHeading(state.headingDeg)) % 360);
  return `#${lat},${lon},${height},${heading}`;
}

/** Parse a location hash; null for anything malformed or out of range. */
export function parsePermalink(hash: string): PermalinkState | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = body.split(',');
  if (parts.length !== 4) return null;
  const [lat, lon, heightM, headingDeg] = parts.map((p) => Number(p.trim()));
  if (![lat, lon, heightM, headingDeg].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  if (heightM < 0 || heightM > 20_000) return null;
  return { lat, lon, heightM, headingDeg: normalizeHeading(headingDeg) };
}

// ---- camera <-> permalink -------------------------------------------------------

/**
 * The current camera position as a permalink state, or null when the
 * ground under the camera can't be sampled (a hash we can't round-trip
 * is worse than no hash).
 */
export async function cameraPermalink(viewer: Viewer): Promise<PermalinkState | null> {
  const c = viewer.camera.positionCartographic;
  const lat = CesiumMath.toDegrees(c.latitude);
  const lon = CesiumMath.toDegrees(c.longitude);
  const ground = await groundHeightM(lon, lat);
  if (ground === undefined) return null;
  return {
    lat,
    lon,
    heightM: Math.max(0, c.height - ground),
    headingDeg: normalizeHeading(CesiumMath.toDegrees(viewer.camera.heading)),
  };
}

/** Update the URL hash in place (replaceState: no history entries). */
export function writePermalink(
  state: PermalinkState,
  win: Pick<Window, 'location' | 'history'> = window,
): void {
  const hash = formatPermalink(state);
  if (win.location.hash !== hash) win.history.replaceState(null, '', hash);
}

/**
 * Keep the hash synced to wherever the camera settles. Returns a detach
 * function. Concurrent samples are coalesced: one sample in flight at a
 * time, taken from the latest settle.
 */
export function attachPermalinkWriter(viewer: Viewer): () => void {
  let sampling = false;
  const onMoveEnd = (): void => {
    if (sampling) return;
    sampling = true;
    void cameraPermalink(viewer)
      .then((state) => {
        if (state) writePermalink(state);
      })
      .catch(() => undefined)
      .finally(() => {
        sampling = false;
      });
  };
  viewer.camera.moveEnd.addEventListener(onMoveEnd);
  return () => {
    viewer.camera.moveEnd.removeEventListener(onMoveEnd);
  };
}

// ---- boot -----------------------------------------------------------------------

/**
 * If `hash` is a valid permalink, teleport there at the stored height and
 * heading and return true. Returns false (without moving the camera) when
 * there is no valid hash or the ground there can't be sampled yet.
 */
export async function applyPermalink(
  viewer: Viewer,
  hash: string = window.location.hash,
): Promise<boolean> {
  const state = parsePermalink(hash);
  if (!state) return false;
  await teleport(viewer, state.lon, state.lat, {
    eyeHeightM: state.heightM,
    headingDeg: state.headingDeg,
    heightAtFn: async (lon, lat) => {
      const ground = await groundHeightM(lon, lat);
      if (ground === undefined) throw new Error('permalink: ground height unavailable');
      return ground;
    },
  });
  return true;
}

/** Boot-time wrapper: never throws, logs and reports false on failure. */
export async function initPermalink(
  viewer: Viewer,
  hash: string = window.location.hash,
): Promise<boolean> {
  try {
    return await applyPermalink(viewer, hash);
  } catch (err) {
    console.warn('permalink: could not restore location from hash:', err);
    return false;
  }
}
