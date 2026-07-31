import { describe, expect, it } from 'vitest';

import type { PixelBuffer } from '../pipeline/buffer.ts';
import { createBuffer } from '../pipeline/buffer.ts';
import { detectGrid } from './gridDetect.ts';

/**
 * Grid detection via autocorrelation (`docs/04-image-pipeline.md` §3.3). These
 * tests build genuine synthetic sources — a small low-res "sprite" that this
 * file itself nearest-neighbour-upscales by a known factor, exactly the W7
 * Case A scenario (`docs/06-workflows.md`) — rather than asserting the
 * function merely runs.
 */

/** A tiny deterministic PRNG so test fixtures are reproducible without a seed dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small random RGBA source where every pixel differs from both its
 * horizontal and vertical neighbour — so an upscale's block edges are
 * guaranteed to produce a nonzero difference signal, never a lucky zero.
 */
function randomLowResSprite(width: number, height: number, seed: number): PixelBuffer {
  const buf = createBuffer(width, height);
  const rand = mulberry32(seed);
  const colorAt = (x: number, y: number): [number, number, number, number] => [
    Math.floor(rand() * 200) + ((x + y) % 2 === 0 ? 0 : 40),
    Math.floor(rand() * 200) + 20,
    Math.floor(rand() * 200) + 10,
    255,
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colorAt(x, y);
      const o = (y * width + x) * 4;
      buf.data[o] = r;
      buf.data[o + 1] = g;
      buf.data[o + 2] = b;
      buf.data[o + 3] = a;
    }
  }
  return buf;
}

/** Nearest-neighbour-upscale `src` by independent integer factors `fx`/`fy`. */
function upscale(src: PixelBuffer, fx: number, fy: number): PixelBuffer {
  const width = src.width * fx;
  const height = src.height * fy;
  const out = createBuffer(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / fy);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / fx);
      const so = (sy * src.width + sx) * 4;
      const o = (y * width + x) * 4;
      out.data[o] = src.data[so];
      out.data[o + 1] = src.data[so + 1];
      out.data[o + 2] = src.data[so + 2];
      out.data[o + 3] = src.data[so + 3];
    }
  }
  return out;
}

/** Photo-like high-frequency noise — no periodic column/row spacing to find. */
function noiseImage(width: number, height: number, seed: number): PixelBuffer {
  const buf = createBuffer(width, height);
  const rand = mulberry32(seed);
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = Math.floor(rand() * 256);
    buf.data[i + 1] = Math.floor(rand() * 256);
    buf.data[i + 2] = Math.floor(rand() * 256);
    buf.data[i + 3] = 255;
  }
  return buf;
}

describe('detectGrid', () => {
  it('recovers an exact known upscale factor (4x)', () => {
    const source = randomLowResSprite(16, 16, 1);
    const upscaled = upscale(source, 4, 4);

    const result = detectGrid(upscaled);

    expect(result).toBeDefined();
    expect(result?.period).toBe(4);
    expect(result?.agreement).toBe(true);
  });

  it('recovers an exact known upscale factor (8x)', () => {
    const source = randomLowResSprite(12, 12, 2);
    const upscaled = upscale(source, 8, 8);

    const result = detectGrid(upscaled);

    expect(result).toBeDefined();
    expect(result?.period).toBe(8);
    expect(result?.agreement).toBe(true);
  });

  it('recovers a non-square (e.g. 3x) factor too', () => {
    const source = randomLowResSprite(20, 20, 3);
    const upscaled = upscale(source, 3, 3);

    const result = detectGrid(upscaled);

    expect(result).toBeDefined();
    expect(result?.period).toBe(3);
  });

  it('does not favour a harmonic of the true period', () => {
    const source = randomLowResSprite(10, 10, 4);
    const upscaled = upscale(source, 6, 6);

    const result = detectGrid(upscaled, { maxPeriod: 24 });

    // 12, 18, 24 are all harmonics of the true period (6) and would also show
    // *some* signal; the true fundamental must still win.
    expect(result?.period).toBe(6);
  });

  it('reports column/row disagreement honestly when factors differ per axis', () => {
    const source = randomLowResSprite(10, 10, 5);
    const upscaled = upscale(source, 8, 4);

    const result = detectGrid(upscaled);

    expect(result).toBeDefined();
    expect(result?.column?.period).toBe(8);
    expect(result?.row?.period).toBe(4);
    expect(result?.agreement).toBe(false);
  });

  it('does not suggest a bogus period on photo-like noise', () => {
    const photo = noiseImage(128, 128, 6);

    const result = detectGrid(photo);

    expect(result).toBeUndefined();
  });

  it('does not suggest a bogus period on a second, differently-seeded noise sample', () => {
    const photo = noiseImage(96, 160, 7);

    const result = detectGrid(photo);

    expect(result).toBeUndefined();
  });

  it('handles a source that is already pixel-sized (no upscale) gracefully', () => {
    // Already at 1x: every column/row differs from its neighbour about as
    // much as every other, structurally identical to noise for this purpose.
    const source = randomLowResSprite(32, 32, 8);

    const result = detectGrid(source);

    expect(result).toBeUndefined();
  });

  it('handles a flat, single-colour source without dividing by zero', () => {
    const flat = createBuffer(40, 40);
    flat.data.fill(0);
    for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255; // opaque

    const result = detectGrid(flat);

    expect(result).toBeUndefined();
  });

  it('respects a caller-supplied maxPeriod ceiling', () => {
    const source = randomLowResSprite(8, 8, 9);
    const upscaled = upscale(source, 10, 10);

    // With the search capped below the true factor, it must fall back to the
    // next-best (and honest) candidate rather than fabricate 10.
    const result = detectGrid(upscaled, { maxPeriod: 5 });

    expect(result === undefined || (result.period <= 5 && result.period !== 10)).toBe(true);
  });

  it('is stable across repeated tiling (16x, larger canvas)', () => {
    const source = randomLowResSprite(24, 18, 10);
    const upscaled = upscale(source, 16, 16);

    const result = detectGrid(upscaled);

    expect(result?.period).toBe(16);
  });
});
