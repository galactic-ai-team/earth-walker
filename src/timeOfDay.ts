// src/timeOfDay.ts
// Scrubable time-of-day driver. Owns an hour value in [0, 24), syncs Cesium's
// clock to it, and emits (hour, sunDir) on change. Nothing else in the app
// should touch viewer.clock directly — go through this module so fog,
// atmosphere and shadows all agree on the time.

import { Cartesian3, JulianDate, Simon1994PlanetaryPositions, Viewer } from 'cesium';

export type TimeOfDayListener = (hour: number) => void;

export class TimeOfDay {
  private viewer: Viewer;
  private hour: number;
  private listeners = new Set<TimeOfDayListener>();
  private unsub: (() => void) | null = null;
  private scratch = new Cartesian3();

  constructor(viewer: Viewer, startHour = 9) {
    this.viewer = viewer;
    this.hour = ((startHour % 24) + 24) % 24;
    this.apply();

    // Fire listeners on every clock tick so fog/atmosphere follow the clock.
    const remove = viewer.clock.onTick.addEventListener(() => {
      const h = this.readClock();
      if (h !== this.hour) {
        this.hour = h;
        this.emit();
      }
    });
    this.unsub = remove;
  }

  /** Current hour in [0, 24). */
  getHour(): number {
    return this.hour;
  }

  /** Set hour and sync the clock. Caller must be on the frame loop (or any). */
  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
    this.apply();
    this.emit();
  }

  /** Subscribe to hour changes. Returns an unsubscribe function. */
  onChange(fn: TimeOfDayListener): () => void {
    this.listeners.add(fn);
    fn(this.hour);
    return () => this.listeners.delete(fn);
  }

  /**
   * Unit sun direction in world space at the current hour, given a reference
   * camera position. Used by shadow quality checks and, if needed, by callers
   * that want to dim UI by sun angle. Not used internally by fog (fog reads
   * scene.light directly — Cesium's SunLight already tracks the real sun).
   */
  getSunDirection(cameraPosition: Cartesian3, out = new Cartesian3()): Cartesian3 {
    const jd = this.toJulian(this.hour);
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(jd, this.scratch);
    Cartesian3.normalize(
      Cartesian3.subtract(this.scratch, cameraPosition, out),
      out,
    );
    return out;
  }

  dispose(): void {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------

  private apply(): void {
    const jd = this.toJulian(this.hour);
    this.viewer.clock.currentTime = jd;
    this.viewer.clock.shouldAnimate = false;
  }

  private readClock(): number {
    const jd = this.viewer.clock.currentTime;
    if (!jd) return this.hour;
    const d = JulianDate.toDate(jd);
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  }

  private toJulian(hour: number): JulianDate {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const jd = JulianDate.fromDate(today);
    return JulianDate.addSeconds(jd, hour * 3600, new JulianDate());
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.hour);
  }
}
