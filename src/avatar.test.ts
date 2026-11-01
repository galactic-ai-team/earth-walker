import { describe, expect, it } from 'vitest';
import { Cartesian3, Matrix4 } from 'cesium';
import { BODY, advancePhase, approachAngle, limbAngle, partLocalMatrix, walkPose } from './avatar';

const centre = (name: string, pose = walkPose(0, 0)) => {
  const part = BODY.find((p) => p.name === name)!;
  return Matrix4.multiplyByPoint(partLocalMatrix(part, pose), Cartesian3.ZERO, new Cartesian3());
};

describe('avatar body + gait', () => {
  it('stands on the ground: shoe soles at z = 0, head at ~1.7-1.8 m', () => {
    const shoe = BODY.find((p) => p.name === 'shoeL')!;
    expect(centre('shoeL').z - shoe.size[2] / 2).toBeCloseTo(0, 2);
    const head = BODY.find((p) => p.name === 'head')!;
    const top = centre('hair').z + 0.07;
    expect(centre('head').z + head.size[2] / 2).toBeGreaterThan(1.65);
    expect(top).toBeLessThan(1.85);
  });

  it('standing still is a neutral pose', () => {
    const p = walkPose(1.3, 0);
    expect(p.legSwing).toBe(0);
    expect(p.armSwing).toBeCloseTo(0);
    expect(p.bob).toBe(0);
  });

  it('a positive swing moves the left foot forward and the right one back', () => {
    const pose = walkPose(Math.PI / 2, 3);
    expect(limbAngle('legL', pose)).toBeGreaterThan(0);
    expect(centre('shoeL', pose).y).toBeGreaterThan(0.2);
    expect(centre('shoeR', pose).y).toBeLessThan(-0.1);
    // arms swing opposite to their leg
    expect(centre('handL', pose).y).toBeLessThan(0);
  });

  it('running swings harder than walking', () => {
    expect(Math.abs(walkPose(Math.PI / 2, 9).legSwing)).toBeGreaterThan(Math.abs(walkPose(Math.PI / 2, 3).legSwing));
  });

  it('gait phase advances with distance, not time', () => {
    expect(advancePhase(0, 0, 1)).toBe(0);
    const a = advancePhase(0, 3, 0.5);
    const b = advancePhase(advancePhase(0, 3, 0.25), 3, 0.25);
    expect(a).toBeCloseTo(b);
    expect(a).toBeGreaterThan(0);
  });

  it('turns the short way round toward the movement heading', () => {
    expect(approachAngle(0, 0.1, 1)).toBeCloseTo(0.1);
    expect(approachAngle(0, 2, 0.5)).toBeCloseTo(0.5);
    // from 350° to 10° goes up through 360°, not down
    const r = approachAngle((350 * Math.PI) / 180, (10 * Math.PI) / 180, 0.1);
    expect(r).toBeGreaterThan((350 * Math.PI) / 180);
  });
});
