// Lane: Lumi — GTA-style third-person chase camera for walk mode.
// The walker (walk.ts) owns the player position; this module only reads its
// WalkState each frame and places the camera behind and above the avatar.
import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, type Viewer } from 'cesium';
import type { WalkState } from './walk';

export type ViewMode = 'third' | 'first';

/** V toggles between the two views. Third-person is the walk-mode default. */
export function nextViewMode(mode: ViewMode): ViewMode {
  return mode === 'third' ? 'first' : 'third';
}

export interface ChaseConfig {
  /** Distance from the look-at pivot to the camera, metres. */
  distance: number;
  /** Look-at pivot above the feet (about shoulder height), metres. */
  pivotHeight: number;
  /** Orbit elevation when the mouse pitch is level, radians (camera above pivot). */
  baseElevation: number;
  minElevation: number;
  maxElevation: number;
  /** Keep the camera at least this far above the ground under it, metres. */
  terrainClearance: number;
  /** Closest the camera may pull in when a building is in the way, metres. */
  minDistance: number;
  /** Position smoothing time constant, seconds. */
  smoothing: number;
}

export const DEFAULT_CHASE: ChaseConfig = {
  distance: 5,
  pivotHeight: 1.6,
  baseElevation: 0.2, // ~1 m above the pivot at 5 m: camera ~2.6 m above the feet
  minElevation: -0.15,
  maxElevation: 1.2,
  terrainClearance: 0.5,
  minDistance: 0.8,
  smoothing: 0.06,
};

/**
 * Orbit elevation from the walker's look pitch: looking up (pitch > 0) drops
 * the camera, looking down raises it, clamped so it never goes under the
 * avatar's feet or straight overhead.
 */
export function orbitElevation(pitch: number, cfg: ChaseConfig = DEFAULT_CHASE): number {
  return CesiumMath.clamp(cfg.baseElevation - pitch, cfg.minElevation, cfg.maxElevation);
}

/**
 * Camera offset from the pivot in local east/north/up metres: `distance`
 * behind the heading (Cesium heading: 0 = north, clockwise) at `elevation`.
 */
export function chaseOffset(
  heading: number,
  elevation: number,
  distance: number,
): { east: number; north: number; up: number } {
  const horiz = distance * Math.cos(elevation);
  return {
    east: -Math.sin(heading) * horiz,
    north: -Math.cos(heading) * horiz,
    up: distance * Math.sin(elevation),
  };
}

/** Raise the camera if the ground under it is higher than camera - clearance. */
export function clearTerrain(cameraHeight: number, groundHeight: number | undefined, clearance: number): number {
  if (groundHeight === undefined) return cameraHeight;
  return Math.max(cameraHeight, groundHeight + clearance);
}

/**
 * Pull the camera in when something blocks the line from the pivot back to it.
 * `isFree(d)` says whether the point d metres back from the pivot is clear;
 * we march outward and stop just short of the first blocked sample.
 */
export function pullInDistance(
  isFree: (d: number) => boolean,
  maxDistance: number,
  minDistance: number,
  step = 0.25,
  margin = 0.3,
): number {
  for (let d = step; d <= maxDistance + 1e-9; d += step) {
    if (!isFree(d)) return CesiumMath.clamp(d - margin, minDistance, maxDistance);
  }
  return maxDistance;
}

/** Fraction of the way to move toward a target this frame (frame-rate independent). */
export function smoothFactor(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}

/** Convert a small local east/north offset (metres) to degrees at a latitude. */
export function offsetDegrees(lat: number, east: number, north: number): { dLon: number; dLat: number } {
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(CesiumMath.toRadians(lat));
  return { dLon: mPerLon !== 0 ? east / mPerLon : 0, dLat: north / mPerLat };
}

export interface ChaseCamOptions {
  groundAt?: (lon: number, lat: number) => number | undefined;
  isBlocked?: (lon: number, lat: number) => boolean;
  config?: Partial<ChaseConfig>;
}

export function createChaseCam(viewer: Viewer, opts: ChaseCamOptions = {}) {
  const cfg: ChaseConfig = { ...DEFAULT_CHASE, ...opts.config };
  const ellipsoid = Ellipsoid.WGS84;
  const smoothed = new Cartesian3();
  let hasSmoothed = false;
  let distance = cfg.distance;
  const scratchCarto = new Cartographic();
  const scratchPivot = new Cartesian3();
  const scratchDir = new Cartesian3();
  const scratchUp = new Cartesian3();
  const scratchRight = new Cartesian3();
  const scratchTarget = new Cartesian3();

  const groundUnder = (lon: number, lat: number): number | undefined =>
    opts.groundAt?.(lon, lat) ?? viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat, 0, scratchCarto));

  return {
    /** Forget the smoothed position (call on enable / mode switch) so the camera snaps into place. */
    reset() {
      hasSmoothed = false;
      distance = cfg.distance;
    },
    /** Place the camera for this frame. Always returns true (it owns the camera). */
    place(state: WalkState, dt: number): boolean {
      const elevation = orbitElevation(state.pitch, cfg);
      const pivotH = state.feet + cfg.pivotHeight;

      // Pull in when a building footprint lies between the avatar and the camera.
      let wanted = cfg.distance;
      if (opts.isBlocked) {
        const back = chaseOffset(state.heading, 0, 1); // unit horizontal "behind" vector
        wanted = pullInDistance(
          (d) => {
            const o = offsetDegrees(state.lat, back.east * d * Math.cos(elevation), back.north * d * Math.cos(elevation));
            return !opts.isBlocked!(state.lon + o.dLon, state.lat + o.dLat);
          },
          cfg.distance,
          cfg.minDistance,
        );
      }
      // Snap in immediately, ease back out slowly (no popping through walls).
      distance = wanted < distance ? wanted : distance + (wanted - distance) * smoothFactor(dt, 0.4);

      const off = chaseOffset(state.heading, elevation, distance);
      const d = offsetDegrees(state.lat, off.east, off.north);
      const camLon = state.lon + d.dLon;
      const camLat = state.lat + d.dLat;
      const camH = clearTerrain(pivotH + off.up, groundUnder(camLon, camLat), cfg.terrainClearance);
      Cartesian3.fromDegrees(camLon, camLat, camH, ellipsoid, scratchTarget);

      if (!hasSmoothed) {
        Cartesian3.clone(scratchTarget, smoothed);
        hasSmoothed = true;
      } else {
        Cartesian3.lerp(smoothed, scratchTarget, smoothFactor(dt, cfg.smoothing), smoothed);
      }
      // Smoothing can cut a chord under a ridge: re-apply terrain clearance as a hard limit.
      const c = Cartographic.fromCartesian(smoothed, ellipsoid, scratchCarto);
      const g = groundUnder(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude));
      const h = clearTerrain(c.height, g, cfg.terrainClearance);
      const destination = Cartesian3.fromRadians(c.longitude, c.latitude, h, ellipsoid, new Cartesian3());

      // Look at the pivot (shoulders) with the local vertical as up.
      Cartesian3.fromDegrees(state.lon, state.lat, pivotH, ellipsoid, scratchPivot);
      Cartesian3.normalize(Cartesian3.subtract(scratchPivot, destination, scratchDir), scratchDir);
      const normal = ellipsoid.geodeticSurfaceNormal(destination, scratchUp);
      Cartesian3.normalize(Cartesian3.cross(scratchDir, normal, scratchRight), scratchRight);
      const up = Cartesian3.normalize(Cartesian3.cross(scratchRight, scratchDir, new Cartesian3()), new Cartesian3());

      viewer.camera.setView({
        destination,
        orientation: { direction: Cartesian3.clone(scratchDir), up },
      });
      return true;
    },
  };
}
