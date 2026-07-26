import { describe, expect, it } from 'vitest';
import { getPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import { drawLine, stampBrush } from './raster';

const WHITE: RGBA = [255, 255, 255, 255];

function blank(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

/** Set of `"x,y"` for every opaque pixel — easier to assert on than raw bytes. */
function litPixels(buf: Uint8ClampedArray, w: number, h: number): Set<string> {
  const lit = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (getPixel(buf, w, h, x, y)![3] !== 0) lit.add(`${x},${y}`);
    }
  }
  return lit;
}

describe('stampBrush', () => {
  it('sets exactly one pixel at size 1', () => {
    const buf = blank(8, 8);
    stampBrush(buf, 8, 8, 3, 4, 1, WHITE);
    expect(litPixels(buf, 8, 8)).toEqual(new Set(['3,4']));
  });

  it('stamps a size×size square', () => {
    const buf = blank(8, 8);
    stampBrush(buf, 8, 8, 4, 4, 3, WHITE);
    expect(litPixels(buf, 8, 8).size).toBe(9);
    // Odd sizes center exactly: offset = (3-1)/2 = 1.
    expect(litPixels(buf, 8, 8).has('3,3')).toBe(true);
    expect(litPixels(buf, 8, 8).has('5,5')).toBe(true);
  });

  it('clips at the buffer edge instead of wrapping', () => {
    const buf = blank(4, 4);
    stampBrush(buf, 4, 4, 0, 0, 3, WHITE);
    // Only the 2×2 quadrant that is actually inside the buffer.
    expect(litPixels(buf, 4, 4)).toEqual(new Set(['0,0', '1,0', '0,1', '1,1']));
  });
});

describe('drawLine', () => {
  it('produces a gap-free stroke between distant pointer samples', () => {
    // The whole reason Bresenham is here: a fast drag reports positions many
    // pixels apart and the stroke must not come out as disconnected dots.
    const buf = blank(32, 32);
    drawLine(buf, 32, 32, 2, 3, 27, 19, 1, WHITE);
    const lit = litPixels(buf, 32, 32);

    expect(lit.has('2,3')).toBe(true);
    expect(lit.has('27,19')).toBe(true);

    // Every lit pixel must have a lit 8-connected neighbour chain back to the
    // start; checking one column per x is enough for a shallow line.
    for (let x = 2; x <= 27; x++) {
      const inColumn = [...lit].filter((p) => p.startsWith(`${x},`));
      expect(inColumn.length).toBeGreaterThan(0);
    }
  });

  it('draws axis-aligned lines with no extra pixels', () => {
    const buf = blank(8, 8);
    drawLine(buf, 8, 8, 1, 5, 6, 5, 1, WHITE);
    expect(litPixels(buf, 8, 8)).toEqual(new Set(['1,5', '2,5', '3,5', '4,5', '5,5', '6,5']));
  });

  it('is symmetric — drawing a line backwards lights the same pixels', () => {
    const a = blank(24, 24);
    const b = blank(24, 24);
    drawLine(a, 24, 24, 1, 2, 20, 11, 1, WHITE);
    drawLine(b, 24, 24, 20, 11, 1, 2, 1, WHITE);
    expect(litPixels(a, 24, 24)).toEqual(litPixels(b, 24, 24));
  });

  it('terminates on a zero-length line', () => {
    const buf = blank(8, 8);
    drawLine(buf, 8, 8, 4, 4, 4, 4, 1, WHITE);
    expect(litPixels(buf, 8, 8)).toEqual(new Set(['4,4']));
  });
});
