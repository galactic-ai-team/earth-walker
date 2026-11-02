// src/sky.ts
// Sun position, sky atmosphere, lighting, shadows and time-of-day fog.
// Free assets only: SkyAtmosphere, Sun and SunLight are all Cesium built-ins.
//
// Lighting strategy: rely on Cesium's default scene.light (SunLight), which
// already tracks the real sun in Earth-fixed space. We do not override it.
//
// Fog color and density are driven by TimeOfDay: warm/thick at dawn and dusk,
// thin/blue at noon, purple at night. Sun shadows come from the default
// SunLight once shadowMap is enabled on the viewer.

import { Color, Viewer } from 'cesium';
import { TimeOfDay } from './timeOfDay';

export interface SkyOptions {
  /** Starting hour, [0, 24). Default 9 (morning). */
  startHour?: number;
  /** Show the Cesium timeline widget. Default false. */
  timeline?: boolean;
  /** Shadow map resolution. Default 2048 (free-tier friendly). */
  shadowMapSize?: number;
}

/** Fog density by hour — thicker at dawn/dusk, thinner at noon, medium at night. */
function fogDensityForHour(hour: number): number {
  // Distance from noon (12.0), 0..12; 0 = noon, 12 = midnight.
  const fromNoon = Math.abs(((hour % 24) + 24) % 24 - 12);
  // Dawn/dusk peak around 6/18 (fromNoon ≈ 6); midnight at fromNoon = 12.
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  const night = Math.max(0, (fromNoon - 8) / 4);
  return 0.00012 + 0.00018 * dawnDusk + 0.00008 * night;
}

/** Fog color by hour — warm at dawn/dusk, blue at noon, dark purple at night. */
function fogColorForHour(hour: number): Color {
  const h = ((hour % 24) + 24) % 24;
  // Key colors at representative hours.
  const night = new Color(0.08, 0.09, 0.16, 0.85); // deep purple-blue
  const dawn = new Color(0.95, 0.65, 0.45, 0.75); // warm peach
  const noon = new Color(0.72, 0.82, 0.92, 0.55); // pale blue
  const dusk = new Color(0.85, 0.55, 0.65, 0.75); // warm rose

  // Piecewise blend across the 24h cycle.
  if (h < 5) return night;
  if (h < 8) return Color.lerp(night, dawn, (h - 5) / 3, new Color());
  if (h < 10) return Color.lerp(dawn, noon, (h - 8) / 2, new Color());
  if (h < 15) return noon;
  if (h < 17) return Color.lerp(noon, dusk, (h - 15) / 2, new Color());
  if (h < 20) return Color.lerp(dusk, night, (h - 17) / 3, new Color());
  return night;
}

/** Atmosphere hue shift by hour — warmer near dawn/dusk, neutral otherwise. */
function atmosphereHueForHour(hour: number): number {
  const fromNoon = Math.abs(((hour % 24) + 24) % 24 - 12);
  const dawnDusk = Math.exp(-((fromNoon - 6) ** 2) / 4);
  return 0.08 * dawnDusk; // warmer near dawn/dusk, 0 at noon/night
}

/**
 * Attach sun/sky/lighting/shadows/fog to a Viewer. Returns a dispose function
 * that stops the fog driver and detaches from TimeOfDay.
 */
export function setupSky(
  viewer: Viewer,
  time: TimeOfDay,
  opts: SkyOptions = {},
): () => void {
  const scene = viewer.scene;

  // Built-in atmosphere.
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.saturationShift = 0.0;
    scene.skyAtmosphere.brightnessShift = 0.0;
  }

  // Built-in sun billboard.
  if (scene.sun) {
    scene.sun.show = true;
  }

  // Globe lighting + atmosphere — Cesium's SunLight shades both.
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;

  // Shadows: enable on viewer, on the globe, and cap shadow map resolution.
  // Cesium's SunLight casts when shadowMap is on. Buildings/trees/avatar set
  // castShadow/receiveShadow on their primitives; those are the other lanes'
  // files, not this one.
  viewer.shadowMap.enabled = true;
  viewer.shadowMap.size = opts.shadowMapSize ?? 2048;
  viewer.shadowMap.softShadows = true;
  scene.globe.shadows = 1; // ENABLED (ShadowMode.ENABLED)

  // Fog on by default; color and density driven by time of day below.
  scene.fog.enabled = true;

  // Timeline widget: hide by default for a walk app.
  if (viewer.timeline) {
    const container = viewer.timeline.container;
    if (container instanceof HTMLElement) {
      container.style.display = opts.timeline ? '' : 'none';
    }
  }

  // Drive fog + atmosphere from time of day. Fire once immediately via
  // onChange's initial call, then on every hour change.
  const unsubscribe = time.onChange((hour) => {
    scene.fog.density = fogDensityForHour(hour);
    scene.fog.color = fogColorForHour(hour);
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.hueShift = atmosphereHueForHour(hour);
    }
  });

  return () => {
    unsubscribe();
    viewer.shadowMap.enabled = false;
  };
}
