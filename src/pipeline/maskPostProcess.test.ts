import { describe, expect, it } from 'vitest';

import { createBuffer, offset, type PixelBuffer } from './buffer.ts';
import {
  featherMask,
  morphologicalClose,
  postProcessMask,
  thresholdMask,
} from './maskPostProcess.ts';
import type { Rgba } from './settings.ts';

/**
 * Mirrors the `#[cfg(test)]` module in `src-tauri/src/pipeline/mask_post_process.rs`.
 * Where a test here has a counterpart there, the two assert the same thing on
 * the same input.
 */

function solid(width: number, height: number, color: Rgba): PixelBuffer {
  const buf = createBuffer(width, height);
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = color[0];
    buf.data[i + 1] = color[1];
    buf.data[i + 2] = color[2];
    buf.data[i + 3] = color[3];
  }
  return buf;
}

function alphaAt(image: PixelBuffer, x: number, y: number): number {
  return image.data[offset(image, x, y) + 3];
}

describe('thresholdMask', () => {
  it('is exclusive below and inclusive at the cutoff', () => {
    const image = solid(3, 1, [1, 2, 3, 0]);
    image.data[offset(image, 0, 0) + 3] = 127;
    image.data[offset(image, 1, 0) + 3] = 128;
    image.data[offset(image, 2, 0) + 3] = 200;

    const out = thresholdMask(image, 128);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 1, 0)).toBe(255);
    expect(alphaAt(out, 2, 0)).toBe(255);
  });

  it('leaves RGB untouched', () => {
    const image = solid(1, 1, [10, 20, 30, 5]);
    const out = thresholdMask(image, 128);
    expect([...out.data.slice(0, 3)]).toEqual([10, 20, 30]);
  });

  it('makes everything opaque at cutoff zero, since nothing is below zero', () => {
    const image = solid(2, 1, [0, 0, 0, 0]);
    const out = thresholdMask(image, 0);
    expect(alphaAt(out, 0, 0)).toBe(255);
    expect(alphaAt(out, 1, 0)).toBe(255);
  });

  it('a low nonzero threshold distinguishes exactly-zero from barely-nonzero alpha', () => {
    const image = solid(2, 1, [0, 0, 0, 0]);
    image.data[offset(image, 1, 0) + 3] = 1;
    const out = thresholdMask(image, 1);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 1, 0)).toBe(255);
  });
});

describe('morphologicalClose', () => {
  it('fills a single-pixel hole fully enclosed by opaque neighbours', () => {
    const image = solid(5, 5, [255, 255, 255, 255]);
    image.data[offset(image, 2, 2) + 3] = 0;

    const out = morphologicalClose(image, 1);
    expect(alphaAt(out, 2, 2)).toBe(255);
  });

  it('does not grow the outer boundary of a large region', () => {
    // A 10x10 fully transparent field with an opaque 4x4 square, itself
    // containing one transparent 1px hole, at its centre.
    const image = solid(10, 10, [255, 255, 255, 0]);
    for (let y = 3; y < 7; y++) {
      for (let x = 3; x < 7; x++) {
        image.data[offset(image, x, y) + 3] = 255;
      }
    }
    image.data[offset(image, 4, 4) + 3] = 0;

    const out = morphologicalClose(image, 1);
    expect(alphaAt(out, 4, 4)).toBe(255);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 9, 9)).toBe(0);
    expect(alphaAt(out, 1, 5)).toBe(0);
  });

  it('radius 0 is a no-op', () => {
    const image = solid(3, 3, [0, 0, 0, 0]);
    image.data[offset(image, 1, 1) + 3] = 200;
    const out = morphologicalClose(image, 0);
    expect(out).toEqual(image);
  });
});

describe('featherMask', () => {
  it('produces a gradient spanning the configured radius', () => {
    const width = 40;
    const image = createBuffer(width, 1);
    for (let x = 0; x < width; x++) {
      const o = offset(image, x, 0);
      const a = x < width / 2 ? 255 : 0;
      image.data.set([10, 20, 30, a], o);
    }

    const radius = 3;
    const out = featherMask(image, radius);

    expect(alphaAt(out, 2, 0)).toBe(255);
    expect(alphaAt(out, width - 3, 0)).toBe(0);

    const edge = width / 2;
    let previous = 256;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.min(Math.max(edge + dx, 0), width - 1);
      const v = alphaAt(out, x, 0);
      expect(v).toBeLessThanOrEqual(previous);
      previous = v;
    }
    const midpoint = alphaAt(out, edge, 0);
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(255);
  });

  it('radius 0 is a no-op', () => {
    const image = solid(4, 4, [0, 0, 0, 0]);
    image.data[offset(image, 2, 2) + 3] = 128;
    const out = featherMask(image, 0);
    expect(out).toEqual(image);
  });

  it('never softens at the canvas border by itself', () => {
    const image = solid(6, 6, [1, 2, 3, 255]);
    const out = featherMask(image, 2);
    expect([...out.data].filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
  });
});

describe('postProcessMask', () => {
  it('runs threshold, then close, then feather, in that order', () => {
    const image = solid(8, 8, [255, 255, 255, 100]);
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) {
        image.data[offset(image, x, y) + 3] = 255;
      }
    }
    image.data[offset(image, 3, 3) + 3] = 0;

    const out = postProcessMask(image, { tolerance: 0, threshold: 128, close: 1, feather: 1 });

    expect(alphaAt(out, 3, 3)).toBe(255);
    expect(alphaAt(out, 0, 0)).toBe(0);
  });

  it('is a no-op when nothing is configured', () => {
    const image = solid(4, 4, [9, 8, 7, 100]);
    image.data[offset(image, 1, 1) + 3] = 0;
    const out = postProcessMask(image, { tolerance: 0.02, close: 0, feather: 0 });
    expect(out).toEqual(image);
  });
});
