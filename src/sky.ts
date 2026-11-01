// src/sky.ts
// Sun position, sky atmosphere and lighting for Cesium — free assets only.
// No Cesium ion: SkyAtmosphere and Sun are built-in Cesium primitives that
// don't hit ion. Directional light is derived from the sun direction each
// frame so shadows/extrusions read correctly as the user scrubs time.

import {
  Cartesian3,
  Color,
  DirectionalLight,
  JulianDate,
  Simon1994PlanetaryPositions,
  Transforms,
  Viewer,
} from 'cesium';

export interface SkyOptions {
  /** Initial time; defaults to now. */
  startTime?: JulianDate;
  /** Multiplier for the clock (1 = real time). Default 60. */
  clockMultiplier?: number;
  /** Whether to allow the user to scrub the timeline. Default true. */
  timeline?: boolean;
}

const SUN_SCRATCH = new Cartesian3();

/**
 * Attach sun/sky/lighting to a Viewer. Returns a dispose function that
 * detaches the pre-render listener.
 *
 * - Sky atmosphere: Cesium's built-in, no ion.
 * - Sun: Cesium's Sun primitive, no ion.
 * - Directional light: recomputed each frame from the camera's local
 *   sun direction so extruded buildings are lit consistently.
 */
export function setupSky(viewer: Viewer, opts: SkyOptions = {}): () => void {
  const scene = viewer.scene;

  // Built-in atmosphere — works without ion.
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = 0.0;
  scene.skyAtmosphere.saturationShift = 0.0;
  scene.skyAtmosphere.brightnessShift = 0.0;

  // Fog hides the terrain horizon seam at low altitudes.
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;

  // Built-in sun (a billboard). No ion.
  scene.sun.show = true;

  // Ambient + directional light for shading extrusions.
  if (!scene.light) {
    // Cesium falls back to a scene light; we set it explicitly below.
  }
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;

  // Clock: real time by default, 60x multiplier so sun visibly moves.
  const start = opts.startTime ?? JulianDate.now();
  viewer.clock.startTime = start.clone();
  viewer.clock.currentTime = start.clone();
  viewer.clock.stopTime = JulianDate.addDays(start, 1, new JulianDate());
  viewer.clock.clockRange = 1; // CLAMPED
  viewer.clock.multiplier = opts.clockMultiplier ?? 60;
  viewer.clock.shouldAnimate = true;
  if (viewer.timeline) viewer.timeline.zoomTo(start, viewer.clock.stopTime);
  if (opts.timeline === false && viewer.timeline) viewer.timeline.container.style.display = 'none';

  // Per-frame: point the directional light from the camera toward the sun.
  // This keeps extrusion lighting correct as the camera moves across the globe
  // and as time advances.
  const remove = scene.preRender.addEventListener(() => {
    const time = viewer.clock.currentTime;
    if (!time) return;

    // Sun position in the ECEF-ish frame at the current camera location.
    // Simon1994PlanetaryPositions is a Cesium built-in, no ion needed.
    const sunEcef = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      SUN_SCRATCH,
    );

    // Transform the camera's local frame so we can express sun as a direction.
    const cameraPosition = scene.camera.positionWC;
    const enu = Transforms.eastNorthUpToFixedFrame(cameraPosition);

    // Direction from camera to sun, in world space.
    const toSun = Cartesian3.subtract(sunEcef, cameraPosition, new Cartesian3());
    Cartesian3.normalize(toSun, toSun);

    // Set a directional light pointing *toward* the camera from the sun's side.
    // DirectionalLight's direction is the direction light travels, so negate.
    const direction = Cartesian3.negate(toSun, new Cartesian3());
    // Transform to world space (already world since we used world positions).
    void enu; // reserved: if we later want a local bounce light.
    scene.light = new DirectionalLight({
      direction,
      intensity: 2.0,
      color: Color.WHITE,
    });
  });

  return () => remove();
}
