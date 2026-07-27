import { describe, expect, it } from 'vitest';

import { fitRect } from './fit.ts';

/**
 * The before/after view has to place two images of different sizes in the same
 * box and have them line up, so the fit is worth pinning down.
 */
describe('fitRect', () => {
  it('centres a wider-than-box image and letterboxes it', () => {
    const r = fitRect({ width: 200, height: 100 }, { width: 400, height: 400 });
    expect(r.w).toBe(400);
    expect(r.h).toBe(200);
    expect(r.x).toBe(0);
    expect(r.y).toBe(100);
  });

  it('centres a taller-than-box image and pillarboxes it', () => {
    const r = fitRect({ width: 100, height: 200 }, { width: 400, height: 400 });
    expect(r.w).toBe(200);
    expect(r.h).toBe(400);
    expect(r.x).toBe(100);
    expect(r.y).toBe(0);
  });

  it('preserves aspect ratio exactly', () => {
    const r = fitRect({ width: 4000, height: 3000 }, { width: 613, height: 409 });
    expect(r.w / r.h).toBeCloseTo(4000 / 3000, 10);
  });

  it('never overflows the box', () => {
    for (const image of [
      { width: 1, height: 1000 },
      { width: 1000, height: 1 },
      { width: 37, height: 41 },
    ]) {
      const r = fitRect(image, { width: 300, height: 200 });
      expect(r.w).toBeLessThanOrEqual(300 + 1e-9);
      expect(r.h).toBeLessThanOrEqual(200 + 1e-9);
    }
  });
});
