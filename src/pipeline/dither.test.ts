import { describe, expect, it } from 'vitest';

import { createBuffer, type PixelBuffer } from './buffer.ts';
import { convert } from './convert.ts';
import {
  ATKINSON,
  FLOYD_STEINBERG,
  bayerMatrix,
  paletteSpread,
  quantizeErrorDiffusion,
  quantizeOrdered,
} from './dither.ts';
import { TRANSPARENT_INDEX, preparePalette, quantizeNone } from './quantize.ts';
import { defaultSettings, type DitherMode, type PaletteSpec, type Rgba } from './settings.ts';

/** Mirrors the `#[cfg(test)]` module in `src-tauri/src/pipeline/dither.rs`. */

const BLACK_AND_WHITE_SPEC: PaletteSpec = {
  kind: 'fixed',
  colors: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ],
};

const blackAndWhite = () =>
  preparePalette([
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ] as Rgba[]);

const opaque = { alphaThreshold: 128, preserveAlpha: false };

function solid(width: number, height: number, color: Rgba): PixelBuffer {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) buf.data.set(color, i);
  return buf;
}

describe('bayerMatrix', () => {
  it('produces the canonical 2x2', () => {
    expect([...bayerMatrix(2)]).toEqual([0, 2, 3, 1]);
  });

  it('produces exactly the 4x4 printed in docs/04 §5.3', () => {
    expect([...bayerMatrix(4)]).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });

  it('is a permutation of 0..n² at every size', () => {
    for (const n of [2, 4, 8]) {
      const m = [...bayerMatrix(n)].sort((a, b) => a - b);
      expect(m).toEqual(Array.from({ length: n * n }, (_, i) => i));
    }
  });

  it('rejects an unsupported size', () => {
    expect(() => bayerMatrix(3)).toThrow();
    expect(() => bayerMatrix(16)).toThrow();
  });
});

describe('paletteSpread', () => {
  it('is zero for a single colour and positive otherwise', () => {
    expect(paletteSpread(preparePalette([[1, 2, 3, 255]]))).toBe(0);
    expect(paletteSpread(blackAndWhite())).toBeGreaterThan(0.5);
  });
});

describe('dithering', () => {
  it('breaks a flat mid-grey into a mix under Bayer', () => {
    const out = quantizeOrdered(solid(8, 8, [128, 128, 128, 255]), blackAndWhite(), opaque, 4, 1);
    expect([...out.indices]).toContain(0);
    expect([...out.indices]).toContain(1);
  });

  it('breaks a flat mid-grey into a mix under Floyd–Steinberg', () => {
    const out = quantizeErrorDiffusion(
      solid(8, 8, [128, 128, 128, 255]),
      blackAndWhite(),
      opaque,
      FLOYD_STEINBERG,
      1,
    );
    expect([...out.indices]).toContain(0);
    expect([...out.indices]).toContain(1);
  });

  it('never dithers a colour that is already in the palette', () => {
    const src = solid(8, 8, [255, 255, 255, 255]);
    const p = blackAndWhite();
    for (const out of [
      quantizeOrdered(src, p, opaque, 8, 1),
      quantizeErrorDiffusion(src, p, opaque, FLOYD_STEINBERG, 1),
      quantizeErrorDiffusion(src, p, opaque, ATKINSON, 1),
    ]) {
      expect([...out.indices].every((i) => i === 1)).toBe(true);
    }
  });

  it('matches undithered output at zero strength', () => {
    const src = createBuffer(16, 16);
    for (let i = 0, p = 0; i < src.data.length; i += 4, p++) {
      const v = Math.min(p, 255);
      src.data.set([v, v, v, 255], i);
    }
    const p = blackAndWhite();
    const plain = quantizeNone(src, p, 'oklab', opaque);
    for (const out of [
      quantizeOrdered(src, p, opaque, 4, 0),
      quantizeErrorDiffusion(src, p, opaque, FLOYD_STEINBERG, 0),
      quantizeErrorDiffusion(src, p, opaque, ATKINSON, 0),
    ]) {
      expect([...out.indices]).toEqual([...plain.indices]);
    }
  });

  it('keeps transparent pixels transparent under every mode', () => {
    const src = solid(4, 4, [128, 128, 128, 0]);
    const p = blackAndWhite();
    for (const out of [
      quantizeOrdered(src, p, opaque, 2, 1),
      quantizeErrorDiffusion(src, p, opaque, FLOYD_STEINBERG, 1),
      quantizeErrorDiffusion(src, p, opaque, ATKINSON, 1),
    ]) {
      expect([...out.indices].every((i) => i === TRANSPARENT_INDEX)).toBe(true);
    }
  });

  it('gives Floyd–Steinberg all the error and Atkinson three quarters', () => {
    const sum = (k: typeof FLOYD_STEINBERG) => k.terms.reduce((n, t) => n + t.weight, 0);
    expect(Math.abs(sum(FLOYD_STEINBERG) - 1)).toBeLessThan(1e-15);
    expect(Math.abs(sum(ATKINSON) - 0.75)).toBeLessThan(1e-15);
  });

  it('serpentines Floyd–Steinberg but not Atkinson', () => {
    expect(FLOYD_STEINBERG.serpentine).toBe(true);
    expect(ATKINSON.serpentine).toBe(false);
  });

  it('runs every mode through convert and stays inside the palette', () => {
    const src = solid(16, 16, [128, 128, 128, 255]);
    const modes: DitherMode[] = [
      'none',
      'floyd-steinberg',
      'atkinson',
      'bayer2',
      'bayer4',
      'bayer8',
    ];
    for (const dither of modes) {
      const out = convert(src, { ...defaultSettings(8, 8, BLACK_AND_WHITE_SPEC), dither });
      expect([...out.indices].every((i) => i < 2)).toBe(true);
    }
  });
});
