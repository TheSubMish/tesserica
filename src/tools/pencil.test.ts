import { describe, expect, it } from 'vitest';
import { getPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import { eraser, pencil } from './pencil';
import type { ToolContext } from './Tool';

const PRIMARY: RGBA = [255, 0, 0, 255];
const SECONDARY: RGBA = [0, 0, 255, 255];

function ctx(size = 8, brushSize = 1, button = 0): ToolContext {
  return {
    buffer: new Uint8ClampedArray(size * size * 4),
    width: size,
    height: size,
    primary: PRIMARY,
    secondary: SECONDARY,
    brushSize,
    button,
  };
}

describe('pencil', () => {
  it('paints the primary colour on press', () => {
    const c = ctx();
    pencil.onPointerDown(c, 3, 4);
    expect(getPixel(c.buffer, c.width, c.height, 3, 4)).toEqual([255, 0, 0, 255]);
  });

  it('paints the secondary colour on the right button', () => {
    const c = ctx(8, 1, 2);
    pencil.onPointerDown(c, 1, 1);
    expect(getPixel(c.buffer, c.width, c.height, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('connects a drag that jumps several pixels', () => {
    // Pointer events arrive far apart on a fast stroke; without interpolation
    // the stroke comes out as disconnected dots.
    const c = ctx();
    pencil.onPointerDown(c, 0, 0);
    pencil.onPointerMove(c, 5, 0, 0, 0);
    for (let x = 0; x <= 5; x++) {
      expect(getPixel(c.buffer, c.width, c.height, x, 0)).toEqual([255, 0, 0, 255]);
    }
  });

  it('writes opaque alpha, not a premultiplied blend', () => {
    const c = ctx();
    c.primary = [255, 0, 0, 128];
    pencil.onPointerDown(c, 2, 2);
    expect(getPixel(c.buffer, c.width, c.height, 2, 2)).toEqual([255, 0, 0, 128]);
  });

  it('honours the brush size', () => {
    const c = ctx(8, 3);
    pencil.onPointerDown(c, 4, 4);
    // 3x3 centred as well as an odd size allows: offset 1 back from the cursor.
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        expect(getPixel(c.buffer, c.width, c.height, x, y)).toEqual([255, 0, 0, 255]);
      }
    }
    expect(getPixel(c.buffer, c.width, c.height, 2, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('eraser', () => {
  it('clears to fully transparent rather than to the background colour', () => {
    const c = ctx();
    pencil.onPointerDown(c, 3, 3);
    eraser.onPointerDown(c, 3, 3);
    expect(getPixel(c.buffer, c.width, c.height, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('clears along a drag', () => {
    const c = ctx();
    pencil.onPointerDown(c, 0, 2);
    pencil.onPointerMove(c, 4, 2, 0, 2);
    eraser.onPointerMove(c, 4, 2, 0, 2);
    for (let x = 0; x <= 4; x++) {
      expect(getPixel(c.buffer, c.width, c.height, x, 2)).toEqual([0, 0, 0, 0]);
    }
  });
});
