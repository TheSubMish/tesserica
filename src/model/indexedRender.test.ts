import { describe, expect, it } from 'vitest';
import { renderIndexedCel } from './indexedRender';
import { TRANSPARENT_INDEX } from './indexBuffers';
import type { Palette } from './types';

const palette: Palette = {
  id: 'p1',
  name: 'Test',
  colors: [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ],
};

describe('renderIndexedCel', () => {
  it('resolves each index to its palette colour', () => {
    const indices = new Uint8Array([1, 2, TRANSPARENT_INDEX, 1]);
    const rgba = renderIndexedCel(indices, palette, 2, 2);
    expect([...rgba]).toEqual([
      255,
      0,
      0,
      255, // index 1 -> red
      0,
      255,
      0,
      255, // index 2 -> green
      0,
      0,
      0,
      0, // index 0 -> transparent
      255,
      0,
      0,
      255,
    ]);
  });

  it('renders fully transparent when no palette is assigned', () => {
    const indices = new Uint8Array([1, 1]);
    const rgba = renderIndexedCel(indices, undefined, 2, 1);
    expect([...rgba]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('is the write-through cache for live palette swapping: same indices, different palette colour, different output', () => {
    const indices = new Uint8Array([1]);
    const before = renderIndexedCel(indices, palette, 1, 1);
    const swapped: Palette = { ...palette, colors: [[10, 20, 30, 255], palette.colors[1]] };
    const after = renderIndexedCel(indices, swapped, 1, 1);
    expect([...before]).toEqual([255, 0, 0, 255]);
    expect([...after]).toEqual([10, 20, 30, 255]);
  });
});
