import { Cartesian3, Cartographic, Math as CesiumMath, type Viewer } from 'cesium';
import { tryHeightAt } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number; // meters above ground
  moveSpeed?: number; // meters per second
  runMultiplier?: number;
  mouseSensitivity?: number;
  /** Steepest slope you can walk UP, degrees. Default 35. */
  maxSlopeDeg?: number;
  /**
   * Steepest slope you can walk DOWN, degrees. Higher than maxSlopeDeg so you
   * can always get down off steep ground you landed on, but you can't stroll
   * off a cliff face. Default 60.
   */
  maxDropDeg?: number;
  /**
   * Distance ahead (metres) over which uphill slope is measured. A fixed
   * look-ahead keeps the limit independent of frame rate and walking speed:
   * per-frame rises are only centimetres, so a per-frame step-up limit
   * would never trigger on continuous terrain. Default 1.5.
   */
  probeDistance?: number;
}

/**
 * Pure math: calculate new longitude and latitude given current position, heading, and movement offsets.
 * Heading follows Cesium: 0 = north, PI/2 = east (clockwise seen from above).
 * 1 degree latitude ≈ 111,320 meters.
 * 1 degree longitude ≈ 111,320 * cos(latitude) meters.
 */
export function calculateMoveOffset(
  currentLon: number,
  currentLat: number,
  headingRad: number,
  forward: number, // positive = forward, negative = backward
  right: number, // positive = right, negative = left

  distanceMeters: number,
): { lon: number; lat: number } {
  const totalForward = forward * distanceMeters;
  const totalRight = right * distanceMeters;

  // "Right" is the heading turned 90° clockwise: (north, east) = (-sin h, cos h).
  const dNorth = totalForward * Math.cos(headingRad) - totalRight * Math.sin(headingRad);
  const dEast = totalForward * Math.sin(headingRad) + totalRight * Math.cos(headingRad);

  const latRadians = CesiumMath.toRadians(currentLat);
  const metersPerLat = 111320;
  const metersPerLon = 111320 * Math.cos(latRadians);

  const dLat = dNorth / metersPerLat;
  const dLon = metersPerLon !== 0 ? dEast / metersPerLon : 0;

  return {
    lon: currentLon + dLon,
    lat: currentLat + dLat,
  };
}

/** Ground height at a point right now, or undefined if no terrain is loaded there yet. */
export type GroundSampler = (lon: number, lat: number) => number | undefined;

export interface Stance {
  lon: number;
  lat: number;
  /** Ground height under the walker, metres. */
  ground: number;
}


export interface StepRules {
  isBlocked?: (lon: number, lat: number) => boolean;
  maxSlopeDeg: number;
  maxDropDeg?: number;
  probeDistance: number;
}

/** Approximate horizontal distance in metres between two nearby points. */
function metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(CesiumMath.toRadians((lat1 + lat2) / 2));
  return Math.hypot(dLat, dLon);
}

function canStand(from: Stance, lon: number, lat: number, ground: GroundSampler, rules: StepRules): number | undefined {
  if (rules.isBlocked?.(lon, lat)) return undefined;
  const g = ground(lon, lat);
  if (g === undefined) return undefined; // terrain not loaded there yet: wait, never drop
  const step = metresBetween(from.lon, from.lat, lon, lat);
  if (step <= 0) return g;
  // Measure the slope over a fixed look-ahead in the direction of travel.
  const k = Math.max(1, rules.probeDistance / step);
  const probeLon = from.lon + (lon - from.lon) * k;
  const probeLat = from.lat + (lat - from.lat) * k;
  const probe = k > 1 ? ground(probeLon, probeLat) : g;
  const rise = (probe ?? g) - from.ground;
  const run = probe === undefined ? step : step * k;
  const limitDeg = rise > 0 ? rules.maxSlopeDeg : (rules.maxDropDeg ?? 90);
  if (limitDeg < 90 && Math.abs(rise) / run > Math.tan(CesiumMath.toRadians(limitDeg))) return undefined;
  return g;
}

/**
 * Pure step resolution: try to move from `from` toward (toLon, toLat).

 * Refuses steps into buildings, steps onto terrain that hasn't loaded, uphill
 * steps steeper than maxSlopeDeg and downhill steps steeper than maxDropDeg
 * (cliff edges), both measured over probeDistance. If the full
 * step is refused, slides along the east-west or north-south component so the
 * walker glides along walls and slopes instead of stopping dead.
 */
export function resolveStep(
  from: Stance,
  toLon: number,
  toLat: number,
  ground: GroundSampler,
  rules: StepRules,
): Stance {
  const candidates: Array<[number, number]> = [
    [toLon, toLat],
    [toLon, from.lat],
    [from.lon, toLat],
  ];
  for (const [lon, lat] of candidates) {
    if (lon === from.lon && lat === from.lat) continue;
    const g = canStand(from, lon, lat, ground, rules);
    if (g !== undefined) return { lon, lat, ground: g };
  }
  // Can't move. Refresh the ground under our feet if we can (it may have
  // loaded since); otherwise keep the last known height.
  const here = ground(from.lon, from.lat);
  return { lon: from.lon, lat: from.lat, ground: here ?? from.ground };
}

/** True when a key event comes from a text field or editable element. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;

  if (el.isContentEditable) return true;
  return typeof el.tagName === 'string' && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName);
}

export function createWalkController(viewer: Viewer, opts: WalkOptions = {}) {
  const eyeHeight = opts.eyeHeight ?? 1.7; // 1.7m average eye height
  const baseSpeed = opts.moveSpeed ?? 3.0; // brisk walk; 1.4 m/s is real-life but feels glacial on a mountain
  const runMultiplier = opts.runMultiplier ?? 3; // Shift: 9 m/s for covering ground
  const sensitivity = opts.mouseSensitivity ?? 0.002;
  const rules: StepRules = {
    isBlocked: opts.isBlocked,
    maxSlopeDeg: opts.maxSlopeDeg ?? 35,
    maxDropDeg: opts.maxDropDeg ?? 60,
    probeDistance: opts.probeDistance ?? 1.5,
  };

  const scratchCarto = new Cartographic();
  const scratchPos = new Cartesian3();

  /**
   * Ground under (lon, lat): the higher of the full-resolution data and the
   * surface the globe is actually drawing there, so the eye never ends up
   * inside the rendered terrain. The drawn surface is only trusted when it's
   * within DRAWN_TOLERANCE of the data: a coarse, not-yet-refined tile can be
   * tens of metres off and would make the camera float, then drop.
   * Undefined until either source is available.
   */
  const DRAWN_TOLERANCE = 5;
  const ground: GroundSampler = (lon, lat) => {
    const data = tryHeightAt(lon, lat);
    const drawn = viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat, 0, scratchCarto));
    if (data === undefined) return drawn;
    if (drawn === undefined || Math.abs(drawn - data) > DRAWN_TOLERANCE) return data;

    return Math.max(data, drawn);
  };

  let enabled = false;
  let hasGround = false;
  let stance: Stance = { lon: 0, lat: 0, ground: 0 };
  let heading = 0; // radians, Cesium convention (clockwise from north)
  let pitch = 0; // radians

  const keys: Record<string, boolean> = {
    KeyW: false,
    KeyS: false,
    KeyA: false,
    KeyD: false,
    ShiftLeft: false,
    ShiftRight: false,
  };

  let lastTime = performance.now();
  let animationFrameId: number | null = null;
  // Restored on disable(): Cesium's own mouse controls and the near plane.
  let savedInputs = true;
  let savedNear = 1;

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (keys[e.code] !== undefined) {
      keys[e.code] = true;
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (keys[e.code] !== undefined) {
      keys[e.code] = false;
    }

  };

  const onBlur = () => {
    for (const k of Object.keys(keys)) keys[k] = false; // no stuck keys after alt-tab
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!enabled || document.pointerLockElement !== viewer.canvas) return;

    heading += e.movementX * sensitivity; // mouse right turns right (heading grows clockwise)
    pitch -= e.movementY * sensitivity;

    // Clamp pitch to avoid neck-snapping (approx -85 to +85 degrees)
    const maxPitch = CesiumMath.toRadians(85);
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  };

  const onClick = () => {
    if (!enabled) return;
    if (document.pointerLockElement !== viewer.canvas) {
      viewer.canvas.requestPointerLock();
    }
  };

  // Synchronous per-frame loop: it never awaits, so disable() always stops it
  // and a slow tile download can't freeze or drop the camera.
  const update = () => {
    if (!enabled) return;

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap dt to avoid huge jumps
    lastTime = now;


    if (!hasGround) {
      // Just enabled: wait (camera untouched) until the ground here is known.
      const g = ground(stance.lon, stance.lat);
      if (g !== undefined) {
        stance = { lon: stance.lon, lat: stance.lat, ground: g };
        hasGround = true;
      }
    } else {
      let forward = 0;
      let right = 0;

      if (keys.KeyW) forward += 1;
      if (keys.KeyS) forward -= 1;
      if (keys.KeyD) right += 1;
      if (keys.KeyA) right -= 1;

      if (forward !== 0 || right !== 0) {
        const isRunning = keys.ShiftLeft || keys.ShiftRight;
        const speed = baseSpeed * (isRunning ? runMultiplier : 1.0);
        // Normalize diagonal movement
        if (forward !== 0 && right !== 0) {
          forward *= Math.SQRT1_2;
          right *= Math.SQRT1_2;
        }
        const next = calculateMoveOffset(stance.lon, stance.lat, heading, forward, right, speed * dt);
        stance = resolveStep(stance, next.lon, next.lat, ground, rules);
      } else {
        // Standing still: follow the ground as finer tiles load.
        const g = ground(stance.lon, stance.lat);
        if (g !== undefined) stance = { lon: stance.lon, lat: stance.lat, ground: g };
      }

    }

    if (hasGround) {
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(stance.lon, stance.lat, stance.ground + eyeHeight, undefined, scratchPos),
        orientation: { heading, pitch, roll: 0.0 },
      });
    }

    animationFrameId = requestAnimationFrame(update);
  };

  return {
    enable(startLon: number, startLat: number) {
      if (enabled) return;
      enabled = true;
      hasGround = false;
      stance = { lon: startLon, lat: startLat, ground: 0 };
      heading = 0;
      pitch = 0;
      lastTime = performance.now();

      // Cesium's orbit/zoom controls would fight the walker every frame.
      const ssc = viewer.scene.screenSpaceCameraController;
      savedInputs = ssc.enableInputs;
      ssc.enableInputs = false;
      // Default near plane is 1 m, wider than the 0.4 m wall clearance, so walls would clip.
      const frustum = viewer.camera.frustum as { near: number };
      savedNear = frustum.near;
      frustum.near = 0.1;

      viewer.canvas.requestPointerLock();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      viewer.canvas.addEventListener('mousemove', onMouseMove);
      viewer.canvas.addEventListener('click', onClick);

      animationFrameId = requestAnimationFrame(update);
    },


    disable() {
      if (!enabled) return;
      enabled = false;

      if (document.pointerLockElement === viewer.canvas) {
        document.exitPointerLock();
      }

      viewer.scene.screenSpaceCameraController.enableInputs = savedInputs;
      (viewer.camera.frustum as { near: number }).near = savedNear;


      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      viewer.canvas.removeEventListener('mousemove', onMouseMove);
      viewer.canvas.removeEventListener('click', onClick);
      onBlur();

      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    },
  };
}
