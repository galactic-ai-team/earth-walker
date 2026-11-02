// src/timeOfDay.ts
// Scrubable time-of-day driver. Owns a solar-time hour in [0, 24), syncs
// Cesium's clock to it, and emits on change. Nothing else in the app should
// touch viewer.clock directly — go through this module so everything agrees
// on the time.
//
// Time basis: LOCAL MEAN SOLAR TIME at the camera's longitude. Hour 9 means
// "mid-morning wherever you are," not 09:00 UTC. The UTC clock is derived as
// (solarHour - longitudeDeg / 15) and Cesium is set to that. This makes "9"
// feel like morning in NYC, Zermatt, and Tokyo without any timezone database.

import { JulianDate, Viewer } from 'cesium';

export type TimeOfDayListener = (hour: number) => void;

export class TimeOfDay {
  private viewer: Viewer;
  private hour: number; // solar hour in [0, 24)
  private listeners = new Set<TimeOfDayListener>();
  private unsub: (() => void) | null = null;

  constructor(viewer: Viewer, startHour = 9) {
    this.viewer = viewer;
    this.hour = ((startHour % 24) + 24) % 24;
    this.apply();

    const remove = viewer.clock.onTick.addEventListener(() => {
      const h = this.readSolarHour();
      if (Math.abs(h - this.hour) > 1e-6) {
        this.hour = h;
        this.emit();
      }
    });
    this.unsub = remove;
  }

  /** Current solar hour in [0, 24). */
  getHour(): number {
    return this.hour;
  }

  /** Set solar hour and sync the clock. */
  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
    this.apply();
    this.emit();
  }

  /** Subscribe to hour changes. Fires immediately with the current hour. */
  onChange(fn: TimeOfDayListener): () => void {
    this.listeners.add(fn);
    fn(this.hour);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------

  private apply(): void {
    this.viewer.clock.currentTime = this.toJulian(this.hour);
    this.viewer.clock.shouldAnimate = false;
  }

  private readSolarHour(): number {
    const jd = this.viewer.clock.currentTime;
    if (!jd) return this.hour;
    const d = JulianDate.toDate(jd);
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const offset = this.getSolarTimeOffsetHours();
    return ((utcHour + offset) % 24 + 24) % 24;
  }

  private toJulian(solarHour: number): JulianDate {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const jd = JulianDate.fromDate(today);
    const offset = this.getSolarTimeOffsetHours();
    const utcHours = solarHour - offset;
    return JulianDate.addSeconds(jd, utcHours * 3600, new JulianDate());
  }

  /**
   * Solar time offset (hours) from UTC at the camera's current longitude.
   * east positive. 15° of longitude = 1 hour of solar time.
   */
  private getSolarTimeOffsetHours(): number {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return 0;
    const lonDeg = (carto.longitude * 180) / Math.PI;
    return lonDeg / 15;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.hour);
  }
}
