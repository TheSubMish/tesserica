import { describe, expect, it } from 'vitest';

import constants from '../../shared/oklab.constants.json';
import {
  LINEAR_TO_LMS,
  LINEAR_TO_SRGB,
  LMS_TO_LINEAR,
  LMS_TO_OKLAB,
  NEAREST_EPSILON,
  OKLAB_TO_LMS,
  SRGB_TO_LINEAR,
  distanceSq,
  linearToSrgb,
  oklabToSrgb,
  oklabToSrgb8,
  srgb8ToOklab,
  srgbToLinear,
  srgbToOklab,
} from './oklab.ts';

/**
 * The first half of this file is the D10 guard: the literals in `oklab.ts` are
 * checked against `shared/oklab.constants.json`, and `oklab.rs` checks its own
 * literals against the same file. Editing one implementation's constants
 * without the other fails a test in the language that was not edited.
 */
describe('constants match shared/oklab.constants.json', () => {
  it('sRGB transfer function', () => {
    expect(SRGB_TO_LINEAR).toEqual(constants.srgbToLinear);
    expect(LINEAR_TO_SRGB).toEqual(constants.linearToSrgb);
  });

  it('forward matrices', () => {
    expect(LINEAR_TO_LMS.map((row) => [...row])).toEqual(constants.linearToLms);
    expect(LMS_TO_OKLAB.map((row) => [...row])).toEqual(constants.lmsToOklab);
  });

  it('inverse matrices', () => {
    expect(OKLAB_TO_LMS.map((row) => [...row])).toEqual(constants.oklabToLms);
    expect(LMS_TO_LINEAR.map((row) => [...row])).toEqual(constants.lmsToLinear);
  });
});

describe('srgbToLinear / linearToSrgb', () => {
  it('anchors at 0 and 1', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 15);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 15);
  });

  it('is near-continuous across the piecewise threshold', () => {
    // The sRGB standard's published constants are rounded, so the two branches
    // do not meet exactly — the step at 0.04045 is ~2.5e-9. That is a property
    // of the standard, not of this code; we assert the size of the step so a
    // real typo in one branch cannot hide inside it.
    const t = SRGB_TO_LINEAR.threshold;
    const step = Math.abs(srgbToLinear(t + 1e-9) - srgbToLinear(t - 1e-9));
    expect(step).toBeLessThan(1e-8);
  });

  it('round-trips every 8-bit value exactly', () => {
    for (let i = 0; i < 256; i++) {
      const c = i / 255;
      expect(Math.round(linearToSrgb(srgbToLinear(c)) * 255)).toBe(i);
    }
  });
});

describe('srgbToOklab', () => {
  // Reference values from Ottosson's published article.
  it('maps white to L=1, a=b=0', () => {
    const w = srgbToOklab(1, 1, 1);
    expect(w.l).toBeCloseTo(1, 6);
    expect(w.a).toBeCloseTo(0, 6);
    expect(w.b).toBeCloseTo(0, 6);
  });

  it('maps black to the origin', () => {
    const k = srgbToOklab(0, 0, 0);
    expect(k.l).toBeCloseTo(0, 12);
    expect(k.a).toBeCloseTo(0, 12);
    expect(k.b).toBeCloseTo(0, 12);
  });

  it('keeps greys achromatic', () => {
    // Ottosson's matrices are published rounded to 10 decimals, so a perfect
    // grey lands ~7e-9 off the neutral axis rather than exactly on it. Well
    // below a JND (~2e-3) and well below the D12 tie-break's reach, but not
    // zero — assert the real bound rather than pretending.
    for (let i = 0; i < 256; i += 17) {
      const c = srgb8ToOklab(i, i, i);
      expect(Math.abs(c.a)).toBeLessThan(1e-7);
      expect(Math.abs(c.b)).toBeLessThan(1e-7);
    }
  });

  it('gives red a positive a and positive b', () => {
    const r = srgbToOklab(1, 0, 0);
    expect(r.a).toBeGreaterThan(0);
    expect(r.b).toBeGreaterThan(0);
  });

  it('gives blue a negative b', () => {
    expect(srgbToOklab(0, 0, 1).b).toBeLessThan(0);
  });

  it('is monotonic in L along the grey ramp', () => {
    let prev = -Infinity;
    for (let i = 0; i < 256; i++) {
      const l = srgb8ToOklab(i, i, i).l;
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
  });
});

describe('srgb8ToOklab', () => {
  it('agrees with the float path', () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [255, 255, 255],
      [12, 200, 77],
      [1, 2, 3],
      [254, 0, 128],
    ]) {
      const viaTable = srgb8ToOklab(r, g, b);
      const viaFloat = srgbToOklab(r / 255, g / 255, b / 255);
      expect(viaTable).toEqual(viaFloat);
    }
  });
});

describe('round trip through Oklab', () => {
  it('recovers every 8-bit colour on a coarse grid exactly', () => {
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          expect(oklabToSrgb8(srgb8ToOklab(r, g, b))).toEqual([r, g, b]);
        }
      }
    }
  });

  it('clamps out-of-gamut Oklab into sRGB rather than wrapping', () => {
    // Vivid green well outside the sRGB gamut.
    const [r, g, b] = oklabToSrgb({ l: 0.9, a: -0.5, b: 0.4 });
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe('distanceSq', () => {
  it('is zero for identical colours', () => {
    expect(distanceSq(srgbToOklab(0.2, 0.4, 0.6), srgbToOklab(0.2, 0.4, 0.6))).toBe(0);
  });

  it('is symmetric', () => {
    const x = srgb8ToOklab(10, 20, 30);
    const y = srgb8ToOklab(200, 100, 50);
    expect(distanceSq(x, y)).toBe(distanceSq(y, x));
  });

  it('ranks a near neighbour below a far one', () => {
    const base = srgb8ToOklab(128, 128, 128);
    const near = srgb8ToOklab(130, 128, 128);
    const far = srgb8ToOklab(255, 0, 0);
    expect(distanceSq(base, near)).toBeLessThan(distanceSq(base, far));
  });

  it('puts the tie-break epsilon far below a JND', () => {
    // A just-noticeable difference in Oklab is ~0.002; the epsilon is applied
    // to *squared* distance, so compare in that space (D12).
    expect(Math.sqrt(NEAREST_EPSILON)).toBeLessThan(0.002 / 50);
  });
});
