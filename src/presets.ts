/** Camera presets. Lane 5 (search/teleport/presets) may extend this list. */
export interface CameraPreset {
  id: string;
  label: string;
  /** degrees */
  lat: number;
  /** degrees */
  lon: number;
  /** eye height above the ellipsoid, metres */
  height: number;
  /** degrees, 0 = north */
  heading: number;
  /** degrees, negative looks down */
  pitch: number;
}

export const PRESETS: readonly CameraPreset[] = [
  { id: 'nyc', label: 'NYC block', lat: 40.7411, lon: -73.9897, height: 300, heading: 30, pitch: -35 },
  { id: 'alps', label: 'Swiss Alps', lat: 45.9763, lon: 7.6586, height: 6000, heading: 250, pitch: -20 },
];
