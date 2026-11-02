import { Viewer, Cartesian3, Math as CesiumMath } from 'cesium';
import { tryHeightAt, GroundSampler } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number;
  moveSpeed?: number;
  sprintMultiplier?: number;
  mouseSensitivity?: number;
  collisionRadius?: number;
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
  maxSlope?: number;
  collisionRadius?: number;
}

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

    let validLon = currentLon;
    let validLat = currentLat;

    if (canStand(targetLon, targetLat, rules.isBlocked, radius)) {
      validLon = targetLon;
      validLat = targetLat;
    } else {
      if (canStand(targetLon, currentLat, rules.isBlocked, radius)) {
        validLon = targetLon;
      } else if (canStand(currentLon, targetLat, rules.isBlocked, radius)) {
        validLat = targetLat;
      } else {
        break;
      }
    }

    const targetHeight = ground(validLon, validLat);
    if (targetHeight === undefined) {
      break;
    }

    if (currentHeight !== undefined) {
      const heightDiff = targetHeight - currentHeight;
      const horizontalDist = Math.hypot(
        (validLat - currentLat) * 111320,
        (validLon - currentLon) * 111320 * Math.cos(CesiumMath.toRadians(currentLat))
      );

      if (horizontalDist > 0 && heightDiff / horizontalDist > maxSlope) {
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
  const baseSpeed = opts.moveSpeed ?? 4.0;
  const sprintMultiplier = opts.sprintMultiplier ?? 1.5; // ~6 m/s sprint
  const sensitivity = opts.mouseSensitivity ?? 0.002;
  const collisionRadius = opts.collisionRadius ?? 0.3;
  const gravity = opts.gravity ?? 14.0;
  const jumpSpeed = opts.jumpSpeed ?? 5.0;

  let enabled = false;
  let lon = 0;
  let lat = 0;
  let currentHeight: number | null = null;
  let heading = 0;
  let pitch = 0;

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
      const isSprinting = keys.ShiftLeft || keys.ShiftRight;
      const speed = baseSpeed * (isSprinting ? sprintMultiplier : 1.0);
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

    lon = targetLon;
    lat = targetLat;
    currentHeight = groundHeight;
    const targetHeight = groundHeight + eyeHeight + heightOffset;

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
      verticalVelocity = 0;
      heightOffset = 0;
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

    getState() {
      const feet = Cartesian3.fromDegrees(lon, lat, (currentHeight ?? 0) + heightOffset);
      return {
        feet,
        heightOffset,
        lon,
        lat,
      };
    },
  };
}
