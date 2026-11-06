import { describe, expect, it } from 'vitest';

import {
  harmonyColors,
  makeRamp,
  nearestInPalette,
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

describe('makeRamp', () => {
  const base: [number, number, number, number] = [200, 90, 40, 255];

  it('has an odd length with the base colour exactly in the middle', () => {
    expect(makeRamp(base, 5)).toHaveLength(5);
    expect(makeRamp(base, 4)).toHaveLength(5);
    expect(makeRamp(base, 5)[2]).toEqual(base);
    expect(makeRamp(base, 1)).toHaveLength(3);
  });

  it('gets monotonically lighter and keeps alpha', () => {
    const ramp = makeRamp([200, 90, 40, 128], 7);
    const ls = ramp.map((c) => rgbToOklch(c).l);
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    expect(ramp.every((c) => c[3] === 128)).toBe(true);
  });

  it('shifts shadows cool and highlights warm', () => {
    const ramp = makeRamp([60, 160, 70, 255], 5); // a green
    const dark = rgbToOklch(ramp[0]);
    const light = rgbToOklch(ramp[4]);
    const mid = rgbToOklch(ramp[2]);
    const dist = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    expect(dist(dark.h, 285)).toBeLessThan(dist(mid.h, 285));
    expect(dist(light.h, 95)).toBeLessThan(dist(mid.h, 95));
  });
});

describe('nearestInPalette', () => {
  const palette: [number, number, number, number][] = [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [255, 0, 0, 255],
  ];

  it('snaps to the perceptually nearest entry and preserves the input alpha', () => {
    expect(nearestInPalette([240, 20, 30, 77], palette)).toEqual([255, 0, 0, 77]);
    expect(nearestInPalette([20, 20, 20, 255], palette)).toEqual([0, 0, 0, 255]);
  });

  it('returns the colour unchanged for an empty palette', () => {
    expect(nearestInPalette([1, 2, 3, 4], [])).toEqual([1, 2, 3, 4]);
  });
});
