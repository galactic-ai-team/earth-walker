import { Viewer, Cartesian3, Math as CesiumMath } from 'cesium';
import { tryHeightAt, GroundSampler } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number;
  moveSpeed?: number;
  runMultiplier?: number;
  mouseSensitivity?: number;
  collisionRadius?: number; // clearance radius around player (default 0.3m)
}

export interface Stance {
  lon: number;
  lat: number;
  heading: number;
  pitch: number;
}

export interface StepRules {
  isBlocked?: (lon: number, lat: number) => boolean;
  maxSlope?: number; // tan(angle), default ~0.839 (40 deg)
  collisionRadius?: number;
}

/**
 * Pure math: calculate new movement offset given heading and inputs.
 */
export function calculateMoveOffset(
  currentLon: number,
  currentLat: number,
  headingRad: number,
  forward: number,
  right: number,
  distanceMeters: number
): { lon: number; lat: number } {
  const totalForward = forward * distanceMeters;
  const totalRight = right * distanceMeters;

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

/**
 * Checks if a position is blocked, including a radial clearance ring (0.3m)
 * to prevent the camera/body from clipping into walls.
 */
export function canStand(
  lon: number,
  lat: number,
  isBlocked?: (lon: number, lat: number) => boolean,
  radiusMeters = 0.3
): boolean {
  if (!isBlocked) return true;
  if (isBlocked(lon, lat)) return false;

  const latOffset = radiusMeters / 111320;
  const lonOffset = radiusMeters / (111320 * Math.cos(CesiumMath.toRadians(lat)));

  if (isBlocked(lon + lonOffset, lat)) return false;
  if (isBlocked(lon - lonOffset, lat)) return false;
  if (isBlocked(lon, lat + latOffset)) return false;
  if (isBlocked(lon, lat - latOffset)) return false;

  return true;
}

/**
 * Claude's core step resolver enhanced with 4 sub-steps and radial clearance checks,
 * preserving slope look-ahead, wall sliding, and ground sampling.
 */
export function resolveStep(
  stance: Stance,
  dLon: number,
  dLat: number,
  ground: GroundSampler,
  rules: StepRules = {}
): { lon: number; lat: number } {
  const radius = rules.collisionRadius ?? 0.3;
  const maxSlope = rules.maxSlope ?? 0.839; // ~40 degrees
  const subSteps = 4;

  const subDLon = dLon / subSteps;
  const subDLat = dLat / subSteps;

  let currentLon = stance.lon;
  let currentLat = stance.lat;
  let currentHeight = ground(currentLon, currentLat);

  for (let step = 0; step < subSteps; step++) {
    const targetLon = currentLon + subDLon;
    const targetLat = currentLat + subDLat;

    // 1. Radial clearance and obstacle check
    let validLon = currentLon;
    let validLat = currentLat;

    if (canStand(targetLon, targetLat, rules.isBlocked, radius)) {
      validLon = targetLon;
      validLat = targetLat;
    } else {
      // Wall sliding: try sliding along Lon or Lat independently
      if (canStand(targetLon, currentLat, rules.isBlocked, radius)) {
        validLon = targetLon;
      } else if (canStand(currentLon, targetLat, rules.isBlocked, radius)) {
        validLat = targetLat;
      } else {
        break; // Completely blocked
      }
    }

    // 2. Ground height and slope checks
    const targetHeight = ground(validLon, validLat);
    if (targetHeight === undefined) {
      // Unloaded tile: hold position for this sub-step
      break;
    }

    if (currentHeight !== undefined) {
      const heightDiff = targetHeight - currentHeight;
      const horizontalDist = Math.hypot(
        (validLat - currentLat) * 111320,
        (validLon - currentLon) * 111320 * Math.cos(CesiumMath.toRadians(currentLat))
      );

      if (horizontalDist > 0 && heightDiff / horizontalDist > maxSlope) {
        // Too steep, slope limit reached
        break;
      }
    }

    currentLon = validLon;
    currentLat = validLat;
    currentHeight = targetHeight;
  }

  return { lon: currentLon, lat: currentLat };
}

export function createWalkController(viewer: Viewer, opts: WalkOptions = {}) {
  const eyeHeight = opts.eyeHeight ?? 1.7;
  const baseSpeed = opts.moveSpeed ?? 5.0;
  const runMultiplier = opts.runMultiplier ?? 2.5;
  const sensitivity = opts.mouseSensitivity ?? 0.002;
  const collisionRadius = opts.collisionRadius ?? 0.3;

  let enabled = false;
  let lon = 0;
  let lat = 0;
  let currentHeight: number | null = null;
  let heading = 0;
  let pitch = 0;

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

  const onKeyDown = (e: KeyboardEvent) => {
    if (keys[e.code] !== undefined) keys[e.code] = true;
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (keys[e.code] !== undefined) keys[e.code] = false;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!enabled || document.pointerLockElement !== viewer.canvas) return;

    heading -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;

    const maxPitch = CesiumMath.toRadians(85);
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  };

  const onClick = () => {
    if (!enabled) return;
    if (document.pointerLockElement !== viewer.canvas) {
      viewer.canvas.requestPointerLock();
    }
  };

  const update = () => {
    if (!enabled) return;

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    let forward = 0;
    let right = 0;

    if (keys.KeyW) forward += 1;
    if (keys.KeyS) forward -= 1;
    if (keys.KeyD) right += 1;
    if (keys.KeyA) right -= 1;

    let targetLon = lon;
    let targetLat = lat;

    if (forward !== 0 || right !== 0) {
      const isRunning = keys.ShiftLeft || keys.ShiftRight;
      const speed = baseSpeed * (isRunning ? runMultiplier : 1.0);
      if (forward !== 0 && right !== 0) {
        forward *= Math.SQRT1_2;
        right *= Math.SQRT1_2;
      }

      const stepDistance = speed * dt;
      const rawTarget = calculateMoveOffset(lon, lat, heading, forward, right, stepDistance);
      const dLon = rawTarget.lon - lon;
      const dLat = rawTarget.lat - lat;

      const groundSampler: GroundSampler = (l, lt) => tryHeightAt(l, lt);
      const resolved = resolveStep(
        { lon, lat, heading, pitch },
        dLon,
        dLat,
        groundSampler,
        { isBlocked: opts.isBlocked, collisionRadius }
      );

      targetLon = resolved.lon;
      targetLat = resolved.lat;
    }

    const groundHeight = tryHeightAt(targetLon, targetLat);
    if (groundHeight === undefined) {
      animationFrameId = requestAnimationFrame(update);
      return;
    }

    lon = targetLon;
    lat = targetLat;
    currentHeight = groundHeight;
    const targetHeight = groundHeight + eyeHeight;

    const position = Cartesian3.fromDegrees(lon, lat, targetHeight);
    viewer.camera.setView({
      destination: position,
      orientation: {
        heading: heading,
        pitch: pitch,
        roll: 0.0,
      },
    });

    animationFrameId = requestAnimationFrame(update);
  };

  return {
    enable(startLon: number, startLat: number) {
      if (enabled) return;
      enabled = true;
      lon = startLon;
      lat = startLat;
      currentHeight = null;
      heading = 0;
      pitch = 0;
      lastTime = performance.now();

      viewer.canvas.requestPointerLock();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
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

      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      viewer.canvas.removeEventListener('mousemove', onMouseMove);
      viewer.canvas.removeEventListener('click', onClick);

      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    },
  };
}
