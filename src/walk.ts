import { Viewer, Cartesian3, Math as CesiumMath } from 'cesium';
import { tryHeightAt } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number;
  moveSpeed?: number;
  runMultiplier?: number;
  mouseSensitivity?: number;
  collisionRadius?: number;
  placeCamera?: (state: WalkState, dt: number) => void;
  gravity?: number;
  jumpSpeed?: number;
}

export interface Stance {
  lon: number;
  lat: number;
  heading: number;
  pitch: number;
}

export interface StepRules {
  isBlocked?: (lon: number, lat: number) => boolean;
  maxSlopeDeg?: number;
  maxDropDeg?: number;
  probeDistance?: number;
  collisionRadius?: number;
}

export interface WalkState {
  lon: number;
  lat: number;
  ground: number;
  feet: number; // height in meters above ellipsoid/ground
  heading: number;
  pitch: number;
  speed: number;
  moveHeading: number;
  eyeHeight: number;
  ready: boolean;
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
 * Radial collision check (0.3m clearance ring) to prevent wall/camera clipping.
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
 * Claude's core step resolver with slope rules, wall sliding, and sub-steps.
 */
export function resolveStep(
  stance: Stance,
  dLon: number,
  dLat: number,
  ground: (lon: number, lat: number) => number | undefined,
  rules: StepRules = {}
): { lon: number; lat: number; ground: number | undefined } {
  const radius = rules.collisionRadius ?? 0.3;
  const maxSlopeDeg = rules.maxSlopeDeg ?? 35;
  const maxDropDeg = rules.maxDropDeg ?? 60;
  const probeDistance = rules.probeDistance ?? 1.5;

  const maxSlope = Math.tan(CesiumMath.toRadians(maxSlopeDeg));
  const maxDrop = Math.tan(CesiumMath.toRadians(maxDropDeg));

  const targetLon = stance.lon + dLon;
  const targetLat = stance.lat + dLat;

  let validLon = stance.lon;
  let validLat = stance.lat;

  // 1. Radial clearance and obstacle check with wall sliding
  if (canStand(targetLon, targetLat, rules.isBlocked, radius)) {
    validLon = targetLon;
    validLat = targetLat;
  } else {
    if (canStand(targetLon, stance.lat, rules.isBlocked, radius)) {
      validLon = targetLon;
    } else if (canStand(stance.lon, targetLat, rules.isBlocked, radius)) {
      validLat = targetLat;
    }
  }

  // 2. Ground sampling at start and target
  const startGround = ground(stance.lon, stance.lat);
  const targetGround = ground(validLon, validLat);

  if (startGround === undefined || targetGround === undefined) {
    return { lon: stance.lon, lat: stance.lat, ground: startGround };
  }

  // 3. Slope and drop limits using probe distance
  const horizontalDist = Math.hypot(
    (validLat - stance.lat) * 111320,
    (validLon - stance.lon) * 111320 * Math.cos(CesiumMath.toRadians(stance.lat))
  );

  if (horizontalDist > 0) {
    const heightDiff = targetGround - startGround;
    const slope = heightDiff / horizontalDist;

    if (heightDiff > 0 && slope > maxSlope) {
      return { lon: stance.lon, lat: stance.lat, ground: startGround };
    }
    if (heightDiff < 0 && Math.abs(slope) > maxDrop && horizontalDist < probeDistance) {
      return { lon: stance.lon, lat: stance.lat, ground: startGround };
    }
  }

  return { lon: validLon, lat: validLat, ground: targetGround };
}

/**
 * Finds a free, unblocked starting position near the target coordinates.
 */
export function findFreeStart(
  startLon: number,
  startLat: number,
  isBlocked?: (lon: number, lat: number) => boolean
): { lon: number; lat: number } {
  if (!isBlocked || canStand(startLon, startLat, isBlocked)) {
    return { lon: startLon, lat: startLat };
  }

  // Spiral search for a free spot
  const radiusSteps = 5;
  const angleSteps = 8;
  const stepSize = 0.5; // meters

  for (let r = 1; r <= radiusSteps; r++) {
    const distMeters = r * stepSize;
    for (let a = 0; a < angleSteps; a++) {
      const angle = (a / angleSteps) * Math.PI * 2;
      const offset = calculateMoveOffset(startLon, startLat, angle, 1, 0, distMeters);
      if (canStand(offset.lon, offset.lat, isBlocked)) {
        return offset;
      }
    }
  }

  return { lon: startLon, lat: startLat };
}

export function createWalkController(viewer: Viewer, opts: WalkOptions = {}) {
  const eyeHeight = opts.eyeHeight ?? 1.7;
  const baseSpeed = opts.moveSpeed ?? 3.0;
  const runMultiplier = opts.runMultiplier ?? 3.0;
  const sensitivity = opts.mouseSensitivity ?? 0.002;
  const collisionRadius = opts.collisionRadius ?? 0.3;
  const gravity = opts.gravity ?? 14.0;
  const jumpSpeed = opts.jumpSpeed ?? 5.0;

  let enabled = false;
  let lon = 0;
  let lat = 0;
  let groundHeight = 0;
  let heading = 0;
  let pitch = 0;
  let currentSpeed = 0;
  let moveHeading = 0;

  // Jump & vertical physics state
  let verticalVelocity = 0;
  let heightOffset = 0; // meters above ground

  const keys: Record<string, boolean> = {
    KeyW: false,
    KeyS: false,
    KeyA: false,
    KeyD: false,
    ShiftLeft: false,
    ShiftRight: false,
    Space: false,
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

  const groundAt = (l: number, lt: number): number => {
    const h = tryHeightAt(l, lt);
    return h !== undefined ? h : groundHeight;
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

    currentSpeed = 0;
    if (forward !== 0 || right !== 0) {
      const isRunning = keys.ShiftLeft || keys.ShiftRight;
      currentSpeed = baseSpeed * (isRunning ? runMultiplier : 1.0);
      if (forward !== 0 && right !== 0) {
        forward *= Math.SQRT1_2;
        right *= Math.SQRT1_2;
      }

      const stepDistance = currentSpeed * dt;
      moveHeading = heading + Math.atan2(right, forward);
      const rawTarget = calculateMoveOffset(lon, lat, heading, forward, right, stepDistance);
      const dLon = rawTarget.lon - lon;
      const dLat = rawTarget.lat - lat;

      const resolved = resolveStep(
        { lon, lat, heading, pitch },
        dLon,
        dLat,
        (l, lt) => tryHeightAt(l, lt),
        { isBlocked: opts.isBlocked, collisionRadius }
      );

      if (resolved.ground !== undefined) {
        lon = resolved.lon;
        lat = resolved.lat;
        groundHeight = resolved.ground;
      }
    } else {
      const h = tryHeightAt(lon, lat);
      if (h !== undefined) {
        groundHeight = h;
      }
    }

    // Handle Jump & Gravity physics
    const isOnGround = heightOffset <= 0.01;
    if (keys.Space && isOnGround) {
      verticalVelocity = jumpSpeed;
    }

    if (!isOnGround || verticalVelocity !== 0 || keys.Space) {
      verticalVelocity -= gravity * dt;
      heightOffset += verticalVelocity * dt;

      if (heightOffset <= 0) {
        heightOffset = 0;
        verticalVelocity = 0;
      }
    }

    const targetHeight = groundHeight + eyeHeight + heightOffset;

    const state: WalkState = {
      lon,
      lat,
      ground: groundHeight,
      feet: groundHeight + heightOffset,
      heading,
      pitch,
      speed: currentSpeed,
      moveHeading,
      eyeHeight,
      ready: true,
    };

    if (opts.placeCamera) {
      opts.placeCamera(state, dt);
    } else {
      const position = Cartesian3.fromDegrees(lon, lat, targetHeight);
      viewer.camera.setView({
        destination: position,
        orientation: { heading, pitch, roll: 0.0 },
      });
    }

    animationFrameId = requestAnimationFrame(update);
  };

  return {
    enable(startLon: number, startLat: number) {
      if (enabled) return;
      enabled = true;

      const free = findFreeStart(startLon, startLat, opts.isBlocked);
      lon = free.lon;
      lat = free.lat;

      const h = tryHeightAt(lon, lat);
      groundHeight = h !== undefined ? h : 0;

      heading = viewer.camera.heading;
      pitch = viewer.camera.pitch;
      verticalVelocity = 0;
      heightOffset = 0;
      lastTime = performance.now();

      viewer.screenSpaceCameraController.enableInputs = false;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = Infinity;
      viewer.camera.frustum.near = 0.1;

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

      viewer.screenSpaceCameraController.enableInputs = true;
      viewer.camera.frustum.near = 1.0;

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

    getState(): WalkState {
      return {
        lon,
        lat,
        ground: groundHeight,
        feet: groundHeight + heightOffset,
        heading,
        pitch,
        speed: currentSpeed,
        moveHeading,
        eyeHeight,
        ready: true,
      };
    },

    groundAt,
  };
}