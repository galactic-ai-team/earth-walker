import { Viewer, Cartesian3, Cartographic, Math as CesiumMath } from 'cesium';
import { tryHeightAt } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number;
  moveSpeed?: number;
  runMultiplier?: number;
  mouseSensitivity?: number;
  collisionRadius?: number;
  placeCamera?: (state: WalkState, dt: number) => boolean;
  gravity?: number;
  jumpSpeed?: number;
}

export interface Stance {
  lon: number;
  lat: number;
  ground: number;
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
  feet: number;
  heading: number;
  pitch: number;
  speed: number;
  moveHeading: number | undefined;
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
 * Core step resolver with slope rules, wall sliding, and look-ahead probe.
 */
export function resolveStep(
  stance: Stance,
  dLon: number,
  dLat: number,
  ground: (lon: number, lat: number) => number | undefined,
  rules: StepRules = {}
): { lon: number; lat: number; ground: number | undefined } {
  const maxSlopeDeg = rules.maxSlopeDeg ?? 35;
  const maxDropDeg = rules.maxDropDeg ?? 60;
  const probeDistance = rules.probeDistance ?? 1.5;

  const maxSlope = Math.tan(CesiumMath.toRadians(maxSlopeDeg));
  const maxDrop = Math.tan(CesiumMath.toRadians(maxDropDeg));

  const targetLon = stance.lon + dLon;
  const targetLat = stance.lat + dLat;

  let validLon = stance.lon;
  let validLat = stance.lat;

  // 1. Obstacle check with wall sliding
  const isBlocked = rules.isBlocked;
  if (!isBlocked || !isBlocked(targetLon, targetLat)) {
    validLon = targetLon;
    validLat = targetLat;
  } else {
    if (!isBlocked(targetLon, stance.lat)) {
      validLon = targetLon;
    } else if (!isBlocked(stance.lon, targetLat)) {
      validLat = targetLat;
    }
  }

  // 2. Ground sampling at start and target
  const startGround = ground(stance.lon, stance.lat);
  const targetGround = ground(validLon, validLat);

  if (startGround === undefined || targetGround === undefined) {
    return { lon: stance.lon, lat: stance.lat, ground: startGround ?? stance.ground };
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
 * Finds a free, unblocked starting position near the target coordinates using 2m rings out to 40m.
 */
export function findFreeStart(
  startLon: number,
  startLat: number,
  isBlocked?: (lon: number, lat: number) => boolean
): { lon: number; lat: number } {
  if (!isBlocked || !isBlocked(startLon, startLat)) {
    return { lon: startLon, lat: startLat };
  }

  const ringStep = 2.0; // meters
  const maxRadius = 40.0;
  const directions = 16;

  for (let r = ringStep; r <= maxRadius; r += ringStep) {
    for (let i = 0; i < directions; i++) {
      const angle = (i / directions) * Math.PI * 2;
      const candidate = calculateMoveOffset(startLon, startLat, angle, 1, 0, r);
      if (!isBlocked(candidate.lon, candidate.lat)) {
        return candidate;
      }
    }
  }

  return { lon: startLon, lat: startLat };
}

/**
 * Pure jump physics step helper.
 */
export function stepJump(
  verticalVelocity: number,
  heightOffset: number,
  dt: number,
  gravity: number,
  jumpRequested: boolean,
  jumpSpeed: number
): { verticalVelocity: number; heightOffset: number } {
  let v = verticalVelocity;
  let h = heightOffset;
  const isOnGround = h <= 0.001;

  if (jumpRequested && isOnGround) {
    v = jumpSpeed;
  }

  if (!isOnGround || v !== 0 || jumpRequested) {
    v -= gravity * dt;
    h += v * dt;

    if (h <= 0) {
      h = 0;
      v = 0;
    }
  }

  return { verticalVelocity: v, heightOffset: h };
}

export function createWalkController(viewer: Viewer, opts: WalkOptions = {}) {
  const eyeHeight = opts.eyeHeight ?? 1.7;
  const baseSpeed = opts.moveSpeed ?? 3.0;
  const runMultiplier = opts.runMultiplier ?? 3.0;
  const sensitivity = opts.mouseSensitivity ?? 0.002;
  const gravity = opts.gravity ?? 14.0;
  const jumpSpeed = opts.jumpSpeed ?? 5.0;

  let enabled = false;
  let lon = 0;
  let lat = 0;
  let groundHeight = 0;
  let heading = 0;
  let pitch = 0;
  let currentSpeed = 0;
  let moveHeading: number | undefined = undefined;
  let hasGround = false;

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
  let savedEnableInputs = true;
  let savedNear = 1.0;
  const scratchCarto = new Cartographic();

  const isTyping = () => {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || (active as HTMLElement).isContentEditable;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping()) return;
    if (keys[e.code] !== undefined) keys[e.code] = true;
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (keys[e.code] !== undefined) keys[e.code] = false;
  };

  const onBlur = () => {
    for (const k of Object.keys(keys)) {
      keys[k] = false;
    }
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
    if (h !== undefined) return h;
    Cartographic.fromDegrees(l, lt, 0, scratchCarto);
    const globeH = viewer.scene.globe.getHeight(scratchCarto);
    if (globeH !== undefined && !isNaN(globeH)) return globeH;
    return groundHeight;
  };

  const update = () => {
    if (!enabled) return;

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    let forward = 0;
    let right = 0;

    if (!isTyping()) {
      if (keys.KeyW) forward += 1;
      if (keys.KeyS) forward -= 1;
      if (keys.KeyD) right += 1;
      if (keys.KeyA) right -= 1;
    }

    currentSpeed = 0;
    moveHeading = undefined;

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
        { lon, lat, ground: groundHeight },
        dLon,
        dLat,
        groundAt,
        { isBlocked: opts.isBlocked }
      );

      if (resolved.ground !== undefined) {
        lon = resolved.lon;
        lat = resolved.lat;
        groundHeight = resolved.ground;
        hasGround = true;
      }
    } else {
      const h = tryHeightAt(lon, lat);
      if (h !== undefined) {
        groundHeight = h;
        hasGround = true;
      }
    }

    if (!hasGround) {
      animationFrameId = requestAnimationFrame(update);
      return;
    }

    // Handle Jump & Gravity physics via stepJump helper
    const jumpRes = stepJump(verticalVelocity, heightOffset, dt, gravity, keys.Space, jumpSpeed);
    verticalVelocity = jumpRes.verticalVelocity;
    heightOffset = jumpRes.heightOffset;

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
      ready: hasGround,
    };

    if (opts.placeCamera && opts.placeCamera(state, dt)) {
      // Handled by custom placeCamera hook (e.g. chase cam)
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
      if (h !== undefined) {
        groundHeight = h;
        hasGround = true;
      } else {
        groundHeight = 0;
        hasGround = false;
      }

      heading = viewer.camera.heading;
      pitch = viewer.camera.pitch;
      verticalVelocity = 0;
      heightOffset = 0;
      lastTime = performance.now();

      savedEnableInputs = viewer.scene.screenSpaceCameraController.enableInputs;
      savedNear = viewer.camera.frustum.near;

      viewer.scene.screenSpaceCameraController.enableInputs = false;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = Infinity;
      viewer.camera.frustum.near = 0.1;

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

      viewer.scene.screenSpaceCameraController.enableInputs = savedEnableInputs;
      viewer.camera.frustum.near = savedNear;

      if (document.pointerLockElement === viewer.canvas) {
        document.exitPointerLock();
      }

      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
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
        ready: hasGround,
      };
    },

    groundAt,
  };
}