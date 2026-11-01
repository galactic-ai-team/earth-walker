import { Viewer, Cartesian3, Math as CesiumMath } from 'cesium';
import { tryHeightAt } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number; // meters above ground
  moveSpeed?: number; // meters per second
  runMultiplier?: number;
  mouseSensitivity?: number;
  collisionRadius?: number; // clearance radius around player (default 0.3m)
}

/**
 * Pure math: calculate new longitude and latitude given current position, heading, and movement offsets.
 * 1 degree latitude ≈ 111,320 meters.
 * 1 degree longitude ≈ 111,320 * cos(latitude) meters.
 */
export function calculateMoveOffset(
  currentLon: number,
  currentLat: number,
  headingRad: number,
  forward: number, // positive = forward, negative = backward
  right: number,   // positive = right, negative = left
  distanceMeters: number
): { lon: number; lat: number } {
  const totalForward = forward * distanceMeters;
  const totalRight = right * distanceMeters;

  // Corrected strafe directions (A = left, D = right)
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
 * Check if a position is blocked, including a radial clearance ring around the player
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
 * Resolves movement with 4 sub-steps per frame to prevent tunneling through thin walls,
 * with wall sliding support.
 */
export function resolveStep(
  startLon: number,
  startLat: number,
  targetLon: number,
  targetLat: number,
  isBlocked?: (lon: number, lat: number) => boolean,
  radiusMeters = 0.3
): { lon: number; lat: number } {
  const subSteps = 4;
  let validLon = startLon;
  let validLat = startLat;

  for (let i = 1; i <= subSteps; i++) {
    const fraction = i / subSteps;
    const subLon = startLon + (targetLon - startLon) * fraction;
    const subLat = startLat + (targetLat - startLat) * fraction;

    if (!canStand(subLon, subLat, isBlocked, radiusMeters)) {
      // Wall sliding: try sliding along X (lon) or Z (lat) individually if blocked
      if (canStand(subLon, validLat, isBlocked, radiusMeters)) {
        validLon = subLon;
      } else if (canStand(validLon, subLat, isBlocked, radiusMeters)) {
        validLat = subLat;
      }
      break;
    } else {
      validLon = subLon;
      validLat = subLat;
    }
  }

  return { lon: validLon, lat: validLat };
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
      
      // Resolve movement with sub-steps and wall sliding
      const resolved = resolveStep(lon, lat, rawTarget.lon, rawTarget.lat, opts.isBlocked, collisionRadius);
      targetLon = resolved.lon;
      targetLat = resolved.lat;
    }

    // Unloaded-tile guard: tryHeightAt returns undefined while loading
    const groundHeight = tryHeightAt(targetLon, targetLat);
    if (groundHeight === undefined) {
      // Hold position and wait for tile to load
      animationFrameId = requestAnimationFrame(update);
      return;
    }

    // 40-degree uphill slope limit (~0.839 tan)
    if (currentHeight !== null) {
      const heightDiff = groundHeight - currentHeight;
      const horizontalDist = Math.hypot(
        (targetLat - lat) * 111320,
        (targetLon - lon) * 111320 * Math.cos(CesiumMath.toRadians(lat))
      );
      const maxSlope = 0.839;
      if (horizontalDist > 0 && heightDiff / horizontalDist > maxSlope) {
        // Too steep, cancel horizontal move
        targetLon = lon;
        targetLat = lat;
      }
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