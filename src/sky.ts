// src/sky.ts
// Sun position, sky atmosphere, lighting, shadows and time-of-day atmosphere.
// Free assets only: SkyAtmosphere, Sun and SunLight are all Cesium built-ins.
//
// Lighting strategy: rely on Cesium's default scene.light (SunLight), which
// already tracks the real sun in Earth-fixed space.
//
// Fog tint note: Cesium's Fog (1.140) has no color property. The atmosphere
// tint comes from SkyAtmosphere.hueShift/saturationShift/brightnessShift
// instead, driven by TimeOfDay's solar hour. This is the closest built-in
// equivalent to tinted fog — the whole sky and horizon warm up at dawn/dusk.
//
// Sun shadows come from the default SunLight once shadowMap is enabled. Each
// lane's primitives (buildings, trees, avatar) opt in with castShadow/
// receiveShadow on their own meshes — this file cannot do that for them.

import { Color, Viewer } from 'cesium';
import { TimeOfDay } from './timeOfDay';

export interface SkyOptions {
  /** Show the Cesium timeline widget. Default false. */
  timeline?: boolean;
  /** Shadow map resolution. Default 2048 (free-tier friendly). */
  shadowMapSize?: number;
}

/**
 * Fog density by solar hour — thicker at dawn/dusk, thinner at noon, medium
 * at night. Pure function; safe to unit test.
 */
export function fogDensityForHour(hour: number): number {
  const fromNoon = Math.abs((((hour % 24) + 24) % 24) - 12);
  // Dawn/dusk peak around fromNoon ≈ 6 (06:00 / 18:00 solar).
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  const night = Math.max(0, (fromNoon - 8) / 4);
  return 0.00012 + 0.00018 * dawnDusk + 0.00008 * night;
}

/**
 * Atmosphere hue shift by solar hour — strongest at dawn/dusk (warm), zero at
 * noon (neutral blue). Cesium's hueShift rotates the full hue wheel; 0.08 is
 * a subtle warm push toward orange/red.
 */
export function atmosphereHueForHour(hour: number): number {
  const fromNoon = Math.abs((((hour % 24) + 24) % 24) - 12);
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  // Warm push at dawn/dusk, neutral at noon and midnight.
  return 0.12 * dawnDusk;
}

/**
 * Atmosphere saturation shift by solar hour — more saturated at dawn/dusk so
 * the warm hue reads as a golden/rose sky rather than a grey one.
 */
export function atmosphereSaturationForHour(hour: number): number {
  const fromNoon = Math.abs((((hour % 24) + 24) % 24) - 12);
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  return 0.18 * dawnDusk;
}

/**
 * Atmosphere brightness shift by solar hour — slightly dimmer at dawn/dusk
 * so the sky doesn't look overexposed when the hue warms up. Neutral at noon.
 */
export function atmosphereBrightnessForHour(hour: number): number {
  const fromNoon = Math.abs((((hour % 24) + 24) % 24) - 12);
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  return -0.10 * dawnDusk;
}

/**
 * Fog tint color by solar hour — kept for future use (post-process grade or
 * Cesium Fog gaining a color property). Not wired to scene.fog.
 */
export function fogColorForHour(hour: number): Color {
  const h = ((hour % 24) + 24) % 24;
  const night = new Color(0.08, 0.09, 0.16, 0.85);
  const dawn = new Color(0.95, 0.65, 0.45, 0.75);
  const noon = new Color(0.72, 0.82, 0.92, 0.55);
  const dusk = new Color(0.85, 0.55, 0.65, 0.75);

  if (h < 5) return night;
  if (h < 8) return Color.lerp(night, dawn, (h - 5) / 3, new Color());
  if (h < 10) return Color.lerp(dawn, noon, (h - 8) / 2, new Color());
  if (h < 15) return noon;
  if (h < 17) return Color.lerp(noon, dusk, (h - 15) / 2, new Color());
  if (h < 20) return Color.lerp(dusk, night, (h - 17) / 3, new Color());
  return night;
}

/**
 * Attach sun/sky/lighting/shadows/atmosphere-tint to a Viewer. Returns a
 * dispose function that stops the time-of-day driver.
 */
export function setupSky(
  viewer: Viewer,
  time: TimeOfDay,
  opts: SkyOptions = {},
): () => void {
  const scene = viewer.scene;

  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
  }

  if (scene.sun) {
    scene.sun.show = true;
  }

  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;

  // Shadows: Cesium's SunLight casts once shadowMap is on. Buildings, trees
  // and avatar must set castShadow/receiveShadow on their own primitives.
  viewer.shadowMap.enabled = true;
  viewer.shadowMap.size = opts.shadowMapSize ?? 2048;
  viewer.shadowMap.softShadows = true;
  scene.globe.shadows = 1; // ShadowMode.ENABLED

  scene.fog.enabled = true;

  if (viewer.timeline) {
    const container = viewer.timeline.container;
    if (container instanceof HTMLElement) {
      container.style.display = opts.timeline ? '' : 'none';
    }
  }

  // Drive fog density + atmosphere tint from time of day. onChange fires
  // immediately, so the initial state is set here too.
  const unsubscribe = time.onChange((hour) => {
    scene.fog.density = fogDensityForHour(hour);
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.hueShift = atmosphereHueForHour(hour);
      scene.skyAtmosphere.saturationShift = atmosphereSaturationForHour(hour);
      scene.skyAtmosphere.brightnessShift = atmosphereBrightnessForHour(hour);
    }
  });

  return () => {
    unsubscribe();
    viewer.shadowMap.enabled = false;
  };
}
