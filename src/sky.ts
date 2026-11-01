// src/sky.ts
// Sun position, sky atmosphere and lighting for Cesium — free assets only.
// No Cesium ion: SkyAtmosphere, Sun and the default SunLight are all built-in
// Cesium primitives that don't hit ion.
//
// Lighting strategy: rely on Cesium's default scene.light, which is a SunLight
// that already tracks the real sun direction in Earth-fixed space. Earlier
// versions of this file set a custom DirectionalLight from an ICRF sun vector
// without the ICRF→fixed rotation, which is wrong — the light direction would
// be rotated by the Earth's spin angle. Cesium's SunLight handles this
// correctly, so we don't override it.

import { JulianDate, Viewer } from 'cesium';

export interface SkyOptions {
  /** Initial time; defaults to now. */
  startTime?: JulianDate;
  /** Clock multiplier. 1 = real time (recommended for a walk app). */
  clockMultiplier?: number;
  /** Whether to show the Cesium timeline widget. Default false. */
  timeline?: boolean;
}

/**
 * Attach sun/sky/lighting to a Viewer. Returns a dispose function (currently
 * a no-op — kept for symmetry with other setup functions and future
 * extensions).
 *
 * - Sky atmosphere: Cesium built-in, no ion.
 * - Sun: Cesium built-in billboard, no ion.
 * - Lighting: Cesium's default SunLight, which tracks the real sun in the
 *   Earth-fixed frame. We do not override it.
 */
export function setupSky(viewer: Viewer, opts: SkyOptions = {}): () => void {
  const scene = viewer.scene;

  // Built-in atmosphere. All optional-typed in recent Cesium; guard.
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.hueShift = 0.0;
    scene.skyAtmosphere.saturationShift = 0.0;
    scene.skyAtmosphere.brightnessShift = 0.0;
  }

  // Fog hides the terrain horizon seam at low altitudes.
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;

  // Built-in sun billboard.
  if (scene.sun) {
    scene.sun.show = true;
  }

  // Cesium's SunLight is the default scene.light; leave it in place. Globe
  // lighting uses it for terrain shading and extrusion lighting.
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;

  // Clock: real time by default. 60x made the sun race across the sky while
  // walking; 1 is the right default for a walk app. Callers can override.
  const start = opts.startTime ?? JulianDate.now();
  viewer.clock.startTime = start.clone();
  viewer.clock.currentTime = start.clone();
  viewer.clock.stopTime = JulianDate.addDays(start, 1, new JulianDate());
  viewer.clock.clockRange = 1; // CLAMPED
  viewer.clock.multiplier = opts.clockMultiplier ?? 1;
  viewer.clock.shouldAnimate = true;

  if (viewer.timeline) {
    const container = viewer.timeline.container;
    if (container instanceof HTMLElement) {
      container.style.display = opts.timeline ? '' : 'none';
    }
    if (opts.timeline) viewer.timeline.zoomTo(start, viewer.clock.stopTime);
  }

  // No per-frame work needed: SunLight tracks the sun automatically.
  // Return a dispose function for symmetry with other setup functions.
  return () => {
    /* nothing to tear down; viewer owns the light and clock */
  };
}