import { Viewer, Cartesian3, Math as CesiumMath } from 'cesium';
import { heightAt } from './terrain';

export interface WalkOptions {
  isBlocked?: (lon: number, lat: number) => boolean;
  eyeHeight?: number; // meters above ground
  moveSpeed?: number; // meters per second
  runMultiplier?: number;
  mouseSensitivity?: number;
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

  // Calculate movement vector in east/north components
  // Heading 0 is North (+lat), Heading pi/2 is East (+lon)
  const dNorth = totalForward * Math.cos(headingRad) + totalRight * Math.sin(headingRad);
  const dEast = totalForward * Math.sin(headingRad) - totalRight * Math.cos(headingRad);

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

export function createWalkController(viewer: Viewer, opts: WalkOptions = {}) {
  const eyeHeight = opts.eyeHeight ?? 1.7; // 1.7m average eye height
  const baseSpeed = opts.moveSpeed ?? 5.0; // 5 m/s walking speed
  const runMultiplier = opts.runMultiplier ?? 2.5;
  const sensitivity = opts.mouseSensitivity ?? 0.002;

  let enabled = false;
  let lon = 0;
  let lat = 0;
  let heading = 0; // radians
  let pitch = 0;   // radians

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
    if (keys[e.code] !== undefined) {
      keys[e.code] = true;
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (keys[e.code] !== undefined) {
      keys[e.code] = false;
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!enabled || document.pointerLockElement !== viewer.canvas) return;

    heading -= e.movementX * sensitivity;
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

  const update = async () => {
    if (!enabled) return;

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap dt to avoid huge jumps
    lastTime = now;

    let forward = 0;
    let right = 0;

    if (keys.KeyW) forward += 1;
    if (keys.KeyS) forward -= 1;
    if (keys.KeyD) right += 1;
    if (keys.KeyA) right -= 1;

    if (forward !== 0 || right !== 0) {
      const isRunning = keys.ShiftLeft || keys.ShiftRight;
      const speed = baseSpeed * (isRunning ? runMultiplier : valClamp(dt));
      // Normalize diagonal movement
      if (forward !== 0 && right !== 0) {
        forward *= Math.SQRT1_2;
        right *= Math.SQRT1_2;
      }

      const stepDistance = speed * dt;
      const nextPos = calculateMoveOffset(lon, lat, heading, forward, right, stepDistance);

      // Check collision / blocking hook if provided
      const blocked = opts.isBlocked ? opts.isBlocked(nextPos.lon, nextPos.lat) : false;
      if (!blocked) {
        lon = nextPos.lon;
        lat = nextPos.lat;
      }
    }

    // Fetch terrain height and ground clamp
    let groundHeight = 0;
    try {
      groundHeight = await heightAt(lon, lat);
    } catch {
      groundHeight = 0;
    }

    const targetHeight = groundHeight + eyeHeight;

    // Update Cesium camera position & orientation
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

  function valClamp(dt: number) {
    return dt;
  }

  return {
    enable(startLon: number, startLat: number) {
      if (enabled) return;
      enabled = true;
      lon = startLon;
      lat = startLat;
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
