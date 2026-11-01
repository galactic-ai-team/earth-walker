import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';

describe('presets', () => {
  it('has the NYC block and Swiss Alps presets with sane coordinates', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['nyc', 'alps']);
    for (const p of PRESETS) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
