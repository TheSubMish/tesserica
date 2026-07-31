import { describe, expect, it } from 'vitest';
import { TRANSPARENT_INDEX } from './indexBuffers';
import { nearestPaletteIndex, paletteFingerprint, resolveIndexToRgba } from './indexedColor';
import type { Palette, RGBA } from './types';

const palette: Palette = {
  id: 'p1',
  name: 'Test',
  colors: [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ],
};

describe('nearestPaletteIndex', () => {
  it('maps alpha 0 to TRANSPARENT_INDEX regardless of RGB', () => {
    const c: RGBA = [123, 45, 67, 0];
    expect(nearestPaletteIndex(c, palette)).toBe(TRANSPARENT_INDEX);
  });

  it('maps an exact palette colour to its 1-based index', () => {
    expect(nearestPaletteIndex([0, 255, 0, 255], palette)).toBe(2);
    expect(nearestPaletteIndex([255, 0, 0, 255], palette)).toBe(1);
  });

  it('snaps an off-palette colour to the nearest entry (Oklab)', () => {
    // Close to red, far from green/blue.
    expect(nearestPaletteIndex([250, 10, 5, 255], palette)).toBe(1);
  });

  it('never returns TRANSPARENT_INDEX for an opaque colour', () => {
    const idx = nearestPaletteIndex([1, 2, 3, 255], palette);
    expect(idx).not.toBe(TRANSPARENT_INDEX);
  });

  it('an empty palette resolves everything to transparent rather than throwing', () => {
    const empty: Palette = { id: 'e', name: 'Empty', colors: [] };
    expect(nearestPaletteIndex([10, 20, 30, 255], empty)).toBe(TRANSPARENT_INDEX);
  });
});

describe('resolveIndexToRgba', () => {
  it('is the exact inverse of nearestPaletteIndex for palette entries', () => {
    for (let i = 0; i < palette.colors.length; i++) {
      const idx = nearestPaletteIndex(palette.colors[i], palette);
      expect(resolveIndexToRgba(idx, palette)).toEqual(palette.colors[i]);
    }
  });

  it('TRANSPARENT_INDEX resolves to fully transparent', () => {
    expect(resolveIndexToRgba(TRANSPARENT_INDEX, palette)).toEqual([0, 0, 0, 0]);
  });

  it('an out-of-range index resolves to transparent rather than throwing', () => {
    expect(resolveIndexToRgba(200, palette)).toEqual([0, 0, 0, 0]);
  });
});

describe('paletteFingerprint', () => {
  it('differs when a colour differs', () => {
    const a: Palette = { id: 'x', name: 'X', colors: [[1, 2, 3, 255]] };
    const b: Palette = { id: 'x', name: 'X', colors: [[1, 2, 4, 255]] };
    expect(paletteFingerprint(a)).not.toBe(paletteFingerprint(b));
  });

  it('is the same for two structurally identical palettes', () => {
    const a: Palette = { id: 'x', name: 'X', colors: [[1, 2, 3, 255]] };
    const b: Palette = { id: 'x', name: 'X', colors: [[1, 2, 3, 255]] };
    expect(paletteFingerprint(a)).toBe(paletteFingerprint(b));
  });

  it('handles an undefined palette (rgba-mode sprite)', () => {
    expect(paletteFingerprint(undefined)).toBe('-');
  });
});
