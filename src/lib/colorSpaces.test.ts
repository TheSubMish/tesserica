import { describe, expect, it } from 'vitest';

import {
  harmonyColors,
  hsvToRgb,
  maxChromaFor,
  oklchToRgb,
  rgbToHsv,
  rgbToOklch,
} from './colorSpaces';

describe('HSV', () => {
  it('round-trips every corner of the cube and some interior points', () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [12, 200, 99],
      [130, 131, 129],
      [250, 3, 77],
    ];
    for (const s of samples) expect(hsvToRgb(rgbToHsv(s))).toEqual(s);
  });

  it('puts red, green and blue at 0, 120 and 240 degrees', () => {
    expect(rgbToHsv([255, 0, 0]).h).toBe(0);
    expect(rgbToHsv([0, 255, 0]).h).toBe(120);
    expect(rgbToHsv([0, 0, 255]).h).toBe(240);
  });

  it('wraps negative hues', () => {
    expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual([0, 0, 255]);
  });
});

describe('Oklch', () => {
  it('round-trips an in-gamut colour to within one 8-bit step', () => {
    const rgb: [number, number, number] = [200, 90, 40];
    const back = oklchToRgb(rgbToOklch(rgb));
    expect(back.inGamut).toBe(true);
    back.rgb.forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(1));
  });

  it('flags impossible chroma as out of gamut', () => {
    expect(oklchToRgb({ l: 0.5, c: 0.37, h: 200 }).inGamut).toBe(false);
  });

  it('maxChromaFor lands on the gamut boundary', () => {
    const c = maxChromaFor(0.6, 30);
    expect(oklchToRgb({ l: 0.6, c, h: 30 }).inGamut).toBe(true);
    expect(oklchToRgb({ l: 0.6, c: c + 0.02, h: 30 }).inGamut).toBe(false);
  });
});

describe('harmonies', () => {
  it('complementary of red is cyan', () => {
    const [a, b] = harmonyColors({ h: 0, s: 1, v: 1 }, 'complementary');
    expect(a).toEqual([255, 0, 0]);
    expect(b).toEqual([0, 255, 255]);
  });

  it('triadic of red is red, green, blue', () => {
    expect(harmonyColors({ h: 0, s: 1, v: 1 }, 'triadic')).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
  });
});
