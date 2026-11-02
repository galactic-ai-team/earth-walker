import { describe, expect, it } from 'vitest';
import { bottomAboveCredits, creditsTop } from './aboveCredits';

describe('bottomAboveCredits', () => {
  it('keeps the old 20 px when there are no credits', () => {
    expect(bottomAboveCredits(844, null)).toBe(20);
  });
  it('lifts the buttons above a 3-line phone credit block (live 390x844: credits from y=759)', () => {
    // 844 - 759 = 85 px of credits + 8 px gap
    expect(bottomAboveCredits(844, 759)).toBe(93);
  });
  it('never goes below the minimum for a thin credit line', () => {
    expect(bottomAboveCredits(800, 790)).toBe(20);
  });
  it('ignores credits laid out below the viewport', () => {
    expect(bottomAboveCredits(800, 900)).toBe(20);
    expect(bottomAboveCredits(800, Number.NaN)).toBe(20);
  });
});

describe('creditsTop', () => {
  const el = (top: number, h: number) => ({ getBoundingClientRect: () => ({ top, width: 10, height: h }) });
  it('returns the topmost visible credit child', () => {
    const container = { querySelectorAll: () => [el(780, 11), el(759, 28), el(700, 0)] } as unknown as Element;
    expect(creditsTop(container)).toBe(759);
  });
  it('is null with no container or nothing visible', () => {
    expect(creditsTop(null)).toBeNull();
    expect(creditsTop({ querySelectorAll: () => [el(700, 0)] } as unknown as Element)).toBeNull();
  });
});
