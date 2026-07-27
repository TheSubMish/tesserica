import { describe, expect, it } from 'vitest';

import { autoPalette, kmeansOklab } from './autopalette.ts';
import { bufferFrom, createBuffer, type PixelBuffer } from './buffer.ts';
import { convert } from './convert.ts';
import { srgb8ToOklab } from './oklab.ts';
import { TRANSPARENT_INDEX } from './quantize.ts';
import { defaultSettings, type Rgba } from './settings.ts';

/** Mirrors `src-tauri/src/pipeline/autopalette.rs`. */

function fromColors(colors: Rgba[]): PixelBuffer {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((c, i) => data.set(c, i * 4));
  return bufferFrom(colors.length, 1, data);
}

function solid(width: number, height: number, color: Rgba): PixelBuffer {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) buf.data.set(color, i);
  return buf;
}

describe('autoPalette', () => {
  it('returns the exact colours when the image has fewer than asked for', () => {
    const image = fromColors([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
    const palette = autoPalette(image, 8, 128);
    expect(palette).toHaveLength(3);
    expect(palette.map((c) => [c[0], c[1], c[2]]).sort()).toEqual(
      [
        [0, 0, 255],
        [0, 255, 0],
        [255, 0, 0],
      ].sort(),
    );
  });

  it('never returns more than maxColors', () => {
    const image = createBuffer(64, 64);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      image.data.set([p & 0xff, (p >> 2) & 0xff, (p >> 4) & 0xff, 255], i);
    }
    for (const n of [2, 4, 8, 16, 32]) {
      expect(autoPalette(image, n, 128).length).toBeLessThanOrEqual(n);
    }
  });

  it('is deterministic', () => {
    const image = createBuffer(48, 48);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      image.data.set([(p * 7) & 0xff, (p * 13) & 0xff, (p * 29) & 0xff, 255], i);
    }
    expect(autoPalette(image, 12, 128)).toEqual(autoPalette(image, 12, 128));
  });

  it('separates two well-spaced clusters', () => {
    // Half the pixels near red, half near blue: a 2-colour palette must be one
    // of each rather than two shades of purple.
    const image = createBuffer(16, 16);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      image.data.set(p % 2 === 0 ? [230, 20, 20, 255] : [20, 20, 230, 255], i);
    }
    const palette = autoPalette(image, 2, 128);
    expect(palette).toHaveLength(2);
    const reds = palette.filter((c) => c[0] > c[2]);
    const blues = palette.filter((c) => c[2] > c[0]);
    expect(reds).toHaveLength(1);
    expect(blues).toHaveLength(1);
  });

  it('ignores transparent pixels when choosing colours', () => {
    const image = createBuffer(8, 8);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      // A loud transparent green that must not reach the palette.
      image.data.set(p < 32 ? [0, 255, 0, 0] : [200, 100, 50, 255], i);
    }
    const palette = autoPalette(image, 4, 128);
    expect(palette.every((c) => !(c[0] === 0 && c[1] === 255 && c[2] === 0))).toBe(true);
  });

  it('still produces a palette for a fully transparent image', () => {
    const palette = autoPalette(solid(4, 4, [9, 9, 9, 0]), 8, 128);
    expect(palette).toHaveLength(1);
  });

  it('rejects a nonsensical maxColors', () => {
    expect(() => autoPalette(solid(2, 2, [1, 2, 3, 255]), 0, 128)).toThrow();
    expect(() => autoPalette(solid(2, 2, [1, 2, 3, 255]), 1.5, 128)).toThrow();
  });

  it('contains no duplicate entries', () => {
    const image = createBuffer(32, 32);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      image.data.set([120 + (p % 3), 120, 120, 255], i);
    }
    const palette = autoPalette(image, 16, 128);
    const keys = palette.map((c) => `${c[0]},${c[1]},${c[2]}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('kmeansOklab', () => {
  it('leaves an empty cluster at its previous centroid', () => {
    const samples = [{ lab: srgb8ToOklab(255, 255, 255), count: 10 }];
    const seed = [srgb8ToOklab(255, 255, 255), srgb8ToOklab(0, 0, 0)];
    const out = kmeansOklab(samples, seed);
    expect(out[1]).toEqual(seed[1]);
  });

  it('moves a centroid onto the mean of the colours assigned to it', () => {
    const samples = [
      { lab: srgb8ToOklab(0, 0, 0), count: 1 },
      { lab: srgb8ToOklab(255, 255, 255), count: 1 },
    ];
    const out = kmeansOklab(samples, [srgb8ToOklab(128, 128, 128)]);
    const expected = (samples[0].lab.l + samples[1].lab.l) / 2;
    expect(out[0].l).toBeCloseTo(expected, 12);
  });
});

describe('convert with an auto palette', () => {
  it('produces indices inside the palette it chose', () => {
    const image = createBuffer(32, 32);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      image.data.set([(p * 5) & 0xff, (p * 11) & 0xff, (p * 17) & 0xff, 255], i);
    }
    const out = convert(image, defaultSettings(8, 8, { kind: 'auto', maxColors: 6 }));
    expect(out.palette.colors.length).toBeLessThanOrEqual(6);
    for (const index of out.indices) {
      if (index === TRANSPARENT_INDEX) continue;
      expect(index).toBeLessThan(out.palette.colors.length);
    }
  });
});
