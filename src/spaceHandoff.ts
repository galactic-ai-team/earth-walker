// src/spaceHandoff.ts — Cosmoscope <-> earth-walker handoff (owner: Lumi).
//
// Cosmoscope (galactic-ai-team/cosmoscope, lumi/earth-handoff) fades to black
// near Earth and opens:
//   https://earth-walker-eight.vercel.app/?from=cosmoscope&hour=14.5#lat,lon,heightM,heading
// The hash is Nova's permalink (src/permalink.ts) unchanged; the handoff
// marker rides in the QUERY string because parsePermalink accepts exactly
// four comma-separated numbers and nothing else.
//
// When from=cosmoscope:
//   - the page fades in from black (matching Cosmoscope's fade-out),
//   - the camera starts in orbit, 15,000 km straight above the spot,
//     looking down with the same heading, then flies straight down (~4.5 s)
//     to 3 km and levels out (~2.5 s) to the permalink's standing height
//     via Nova's teleport(),
//   - ?hour= (local solar hour of that spot in Cosmoscope's sky) sets Dee's
//     TimeOfDay, so the day side in space lands in daylight,
//   - the query is then dropped from the URL (replaceState), so reloading
//     or sharing gives a normal street-level permalink, not a re-descent.
// A "Back to space" link is always shown; it opens Cosmoscope framed on
// Earth via Cosmoscope's existing deep link (#to=planet:earth, deepLink.ts).

import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium';

import { parsePermalink, type PermalinkState } from './permalink';
import { planLanding, type LandingPlan } from './terrain';
import { teleport } from './search';

export const COSMOSCOPE_URL = 'https://cosmoscope-chi.vercel.app/';
/** Cosmoscope deep link that flies to Earth (its 'orbit' framing). */
export const BACK_TO_SPACE_URL = `${COSMOSCOPE_URL}#to=planet:earth`;
/** Start of the descent: metres above the ellipsoid (whole Earth in view). */
export const DESCENT_START_HEIGHT_M = 15_000_000;
/** Pause in orbit before descending, so the globe's first tiles can load. */
export const DESCENT_HOLD_MS = 900;
export const FADE_IN_MS = 1200;

export interface SpaceHandoff {
  fromCosmoscope: boolean;
  /** Local solar hour [0, 24) from Cosmoscope, or null. */
  hour: number | null;
  /** The permalink to land on, or null if the hash isn't one. */
  target: PermalinkState | null;
}

/** Parse location.search + location.hash. Pure; unit-tested. */
export function parseSpaceHandoff(search: string, hash: string): SpaceHandoff {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fromCosmoscope = q.get('from') === 'cosmoscope';
  const rawHour = q.get('hour');
  const h = rawHour === null || rawHour.trim() === '' ? NaN : Number(rawHour);
  const hour = fromCosmoscope && Number.isFinite(h) && h >= 0 && h <= 24 ? h % 24 : null;
  return { fromCosmoscope, hour, target: parsePermalink(hash) };
}

/** The URL to leave in the address bar after a handoff: same page, no query, keep the hash. */
export function strippedHandoffUrl(pathname: string, search: string, hash: string): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  q.delete('from');
  q.delete('hour');
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}

/** Orbit start pose straight above the target, looking down, same heading. Pure; unit-tested. */
export function descentStartPose(t: PermalinkState): { lon: number; lat: number; heightM: number; headingDeg: number; pitchDeg: number } {
  return { lon: t.lon, lat: t.lat, heightM: DESCENT_START_HEIGHT_M, headingDeg: t.headingDeg, pitchDeg: -90 };
}

// ---- DOM / Cesium (not unit-tested; checked in a headless browser) ----

/** Always-on "Back to space" link (top-right; under the presets row on narrow screens). */
export function mountBackToSpace(doc: Document = document): HTMLAnchorElement {
  const a = doc.createElement('a');
  a.id = 'back-to-space';
  a.href = BACK_TO_SPACE_URL;
  a.textContent = '🪐 Back to space';
  a.title = 'Open Cosmoscope, the 3D map of the universe, at Earth';
  doc.body.appendChild(a);
  return a;
}

/** Black overlay that fades out, continuing Cosmoscope's fade to black. */
export function fadeInFromBlack(doc: Document = document, ms = FADE_IN_MS): void {
  const el = doc.createElement('div');
  el.id = 'space-fade';
  el.style.transition = `opacity ${ms}ms ease-out`;
  doc.body.appendChild(el);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), ms + 100);
    }),
  );
}

/** Phase 1 ends this far above the ground, still looking straight down. */
export const DESCENT_LOOKDOWN_HEIGHT_M = 3_000;
export const DESCENT_PHASE1_S = 4.5;
export const DESCENT_PHASE2_S = 2.5;

function flyCamera(viewer: Viewer, lon: number, lat: number, heightM: number, headingDeg: number, pitchDeg: number, duration: number): Promise<void> {
  return new Promise<void>((resolve) =>
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, heightM),
      orientation: { heading: CesiumMath.toRadians(headingDeg), pitch: CesiumMath.toRadians(pitchDeg), roll: 0 },
      duration,
      complete: () => resolve(),
      cancel: () => resolve(),
    }),
  );
}

/**
 * Start in orbit above `t` and fly down. Cosmoscope's Earth is untextured, so
 * the spot is often at sea: planLanding() (Claude, terrain.ts) picks the
 * nearest dry ground instead, or a hover above open ocean.
 *   - land:    dive straight down above the landing spot to 3 km, then Nova's
 *              teleport() levels out to the standing height and heading;
 *   - ocean:   no land within ~400 km, so glide down to 300 m above the water,
 *              looking at the horizon;
 *   - unknown: terrain couldn't be fetched, so stop high (3 km above the
 *              ellipsoid, looking down 30 deg) rather than risk hovering
 *              inside a mountain.
 */
export async function descendFromSpace(viewer: Viewer, t: PermalinkState): Promise<LandingPlan['kind']> {
  const s = descentStartPose(t);
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(s.lon, s.lat, s.heightM),
    orientation: { heading: CesiumMath.toRadians(s.headingDeg), pitch: CesiumMath.toRadians(s.pitchDeg), roll: 0 },
  });
  // Start the search now; it runs during the hold (coarse tiles, a few seconds at most).
  const planP = planLanding(t.lon, t.lat).catch((): LandingPlan => ({ kind: 'unknown', lon: t.lon, lat: t.lat }));
  await new Promise((r) => setTimeout(r, DESCENT_HOLD_MS));
  const plan = await planP;

  if (plan.kind === 'ocean') {
    await flyCamera(viewer, plan.lon, plan.lat, plan.hoverHeightM, t.headingDeg, -10, DESCENT_PHASE1_S + DESCENT_PHASE2_S);
    return plan.kind;
  }
  if (plan.kind === 'unknown') {
    console.warn('space handoff: terrain unavailable, stopping high above the spot');
    await flyCamera(viewer, plan.lon, plan.lat, 3_000, t.headingDeg, -30, DESCENT_PHASE1_S + DESCENT_PHASE2_S);
    return plan.kind;
  }
  // From 15,000 km up, aiming the dive at a spot moved a few km (or a few
  // hundred) to the coast is invisible; it just lands on dry ground.
  await flyCamera(viewer, plan.lon, plan.lat, plan.ground + DESCENT_LOOKDOWN_HEIGHT_M, t.headingDeg, -90, DESCENT_PHASE1_S);
  await teleport(viewer, plan.lon, plan.lat, {
    eyeHeightM: t.heightM,
    headingDeg: t.headingDeg,
    duration: DESCENT_PHASE2_S,
    heightAtFn: async () => plan.ground,
  });
  return plan.kind;
}
