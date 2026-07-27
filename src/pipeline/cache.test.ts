import { describe, expect, it } from 'vitest';

import { createBuffer } from './buffer.ts';
import { NearestCache, preparePalette, quantizeNone } from './quantize.ts';
import type { Rgba } from './settings.ts';

/** Mirrors the cache tests in `src-tauri/src/pipeline/quantize.rs`. */

const opaque = { alphaThreshold: 128, preserveAlpha: false };

function greyRamp(n: number) {
  const colors: Rgba[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.round((i * 255) / (n - 1));
    colors.push([v, v, v, 255]);
  }
  return preparePalette(colors);
}

describe('NearestCache', () => {
  it('cannot change a single pixel', () => {
    const palette = greyRamp(8);
    const src = createBuffer(64, 64);
    // Deliberately fill a single 5-bit bucket with many distinct colours: 0..8
    // in each channel all share one slot, so this is the exact case a lossy
    // table would get wrong and a tag-checked one gets right.
    for (let i = 0, p = 0; p < 64 * 64; p++, i += 4) {
      src.data[i] = p % 8;
      src.data[i + 1] = Math.floor(p / 8) % 8;
      src.data[i + 2] = Math.floor(p / 64) % 8;
      src.data[i + 3] = 255;
    }

    const without = quantizeNone(src, palette, 'oklab', opaque);
    const withCache = quantizeNone(src, palette, 'oklab', opaque, new NearestCache(1));

    expect([...withCache.indices]).toEqual([...without.indices]);
    expect([...withCache.image.data]).toEqual([...without.image.data]);
  });

  it('recomputes on a tag mismatch rather than returning a neighbour’s answer', () => {
    const cache = new NearestCache(1);
    expect(NearestCache.slot(0, 0, 0)).toBe(NearestCache.slot(7, 7, 7));
    expect(NearestCache.tag(0, 0, 0)).not.toBe(NearestCache.tag(7, 7, 7));

    expect(cache.lookup(0, 0, 0, 0, () => 11)).toBe(11);
    expect(cache.lookup(7, 7, 7, 0, () => 22)).toBe(22);
    expect(cache.lookup(0, 0, 0, 0, () => 33)).toBe(33);
  });

  it('hits on a repeat of the same colour', () => {
    const cache = new NearestCache(1);
    expect(cache.lookup(9, 40, 200, 0, () => 5)).toBe(5);
    // The compute callback must not run; if it did, this would be 6.
    expect(cache.lookup(9, 40, 200, 0, () => 6)).toBe(5);
  });

  it('keeps lanes apart', () => {
    const cache = new NearestCache(4);
    expect(cache.lookup(1, 2, 3, 0, () => 10)).toBe(10);
    expect(cache.lookup(1, 2, 3, 3, () => 20)).toBe(20);
    expect(cache.lookup(1, 2, 3, 0, () => 99)).toBe(10);
  });

  it('rejects a non-positive lane count', () => {
    expect(() => new NearestCache(0)).toThrow();
  });
});
