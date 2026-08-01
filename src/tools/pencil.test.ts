import { describe, expect, it } from 'vitest';
import { getPixel } from '../model/pixelBuffers';
import { TRANSPARENT_INDEX } from '../model/indexBuffers';
import type { Palette } from '../model/types';
import { isRedundantCorner, pencil } from './pencil';
import { eraser } from './eraser';
import { harness, litPixels } from './testHarness';

describe('pencil', () => {
  it('paints the primary colour on press', () => {
    const c = harness();
    pencil.onPointerDown(c, 3, 4);
    expect(getPixel(c.buffer, c.width, c.height, 3, 4)).toEqual([255, 0, 0, 255]);
  });

  it('paints the secondary colour on the right button', () => {
    const c = harness({ button: 2 });
    pencil.onPointerDown(c, 1, 1);
    expect(getPixel(c.buffer, c.width, c.height, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('connects a drag that jumps several pixels', () => {
    // Pointer events arrive far apart on a fast stroke; without interpolation
    // the stroke comes out as disconnected dots.
    const c = harness();
    pencil.onPointerDown(c, 0, 0);
    pencil.onPointerMove(c, 5, 0, 0, 0);
    for (let x = 0; x <= 5; x++) {
      expect(getPixel(c.buffer, c.width, c.height, x, 0)).toEqual([255, 0, 0, 255]);
    }
  });

  it('writes opaque alpha, not a premultiplied blend', () => {
    const c = harness({ primary: [255, 0, 0, 128] });
    pencil.onPointerDown(c, 2, 2);
    expect(getPixel(c.buffer, c.width, c.height, 2, 2)).toEqual([255, 0, 0, 128]);
  });

  it('honours the brush size', () => {
    const c = harness({ brushSize: 3 });
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

describe('isRedundantCorner', () => {
  it('recognises the L that a Bresenham diagonal produces', () => {
    // (0,0) → (1,0) → (1,1): the middle pixel is the doubled corner.
    expect(isRedundantCorner({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(true);
    expect(isRedundantCorner({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(true);
  });

  it('leaves straight runs alone', () => {
    expect(isRedundantCorner({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBe(false);
  });

  it('leaves genuine right angles alone', () => {
    // (0,0) → (1,0) → (1,2) is not a one-pixel corner; removing (1,0) would
    // break the line.
    expect(isRedundantCorner({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 })).toBe(false);
  });
});

/**
 * The doubling comes from *pointer sampling*, not from Bresenham: a hand
 * moving diagonally reports (0,0) → (1,0) → (1,1), and drawing all three
 * gives an L where the eye wants a diagonal step.
 */
const L_STAIRCASE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 1],
  [2, 2],
];

function dragThrough(c: ReturnType<typeof harness>, path: [number, number][]): void {
  c.snapshot();
  pencil.onPointerDown(c, path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) {
    pencil.onPointerMove(c, path[i][0], path[i][1], path[i - 1][0], path[i - 1][1]);
  }
}

describe('pixel-perfect mode', () => {
  it('retracts the doubled corners of a freehand diagonal', () => {
    const c = harness({ pixelPerfect: true });
    dragThrough(c, L_STAIRCASE);
    expect(litPixels(c.buffer, c.width, c.height)).toEqual(new Set(['0,0', '1,1', '2,2']));
  });

  it('keeps them when the mode is off', () => {
    const c = harness({ pixelPerfect: false });
    dragThrough(c, L_STAIRCASE);
    expect(litPixels(c.buffer, c.width, c.height)).toEqual(
      new Set(['0,0', '1,0', '1,1', '2,1', '2,2']),
    );
  });

  it('restores the corner to what was underneath, not to transparent', () => {
    const c = harness({ pixelPerfect: true });
    // Something already drawn under the corner the pencil will retract.
    c.buffer.set([9, 9, 9, 255], (0 * c.width + 1) * 4);
    dragThrough(c, [
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(getPixel(c.buffer, c.width, c.height, 1, 0)).toEqual([9, 9, 9, 255]);
  });

  it('is skipped for wide brushes, which have no single corner pixel', () => {
    const c = harness({ pixelPerfect: true, brushSize: 3 });
    dragThrough(c, [
      [3, 3],
      [4, 3],
      [4, 4],
    ]);
    // 3×3 stamps at all three positions, none retracted: the union of
    // (2..4,2..4), (3..5,2..4) and (3..5,3..5).
    expect(litPixels(c.buffer, c.width, c.height).size).toBe(15);
  });
});

describe('eraser', () => {
  it('clears to fully transparent rather than to the background colour', () => {
    const c = harness();
    pencil.onPointerDown(c, 3, 3);
    eraser.onPointerDown(c, 3, 3);
    expect(getPixel(c.buffer, c.width, c.height, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('clears along a drag', () => {
    const c = harness();
    pencil.onPointerDown(c, 0, 2);
    pencil.onPointerMove(c, 4, 2, 0, 2);
    eraser.onPointerMove(c, 4, 2, 0, 2);
    for (let x = 0; x <= 4; x++) {
      expect(getPixel(c.buffer, c.width, c.height, x, 2)).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('pencil and eraser — indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  const palette: Palette = {
    id: 'p1',
    name: 'P',
    colors: [
      [255, 0, 0, 255], // -> index 1
      [0, 255, 0, 255], // -> index 2
    ],
  };

  function indexedHarness() {
    return harness({
      colorMode: 'indexed',
      palette,
      buffer: new Uint8Array(8 * 8),
      primary: [255, 0, 0, 255],
      secondary: [0, 255, 0, 255],
    });
  }

  it('writes a palette index, not RGBA', () => {
    const c = indexedHarness();
    pencil.onPointerDown(c, 3, 4);
    expect(getPixel(c.buffer, c.width, c.height, 3, 4, 1)).toEqual([1]);
  });

  it('snaps an off-palette colour to the nearest palette entry (Oklab) — the D9 policy', () => {
    const c = indexedHarness();
    c.primary = [250, 5, 5, 255]; // close to red, not an exact palette entry
    pencil.onPointerDown(c, 0, 0);
    expect(getPixel(c.buffer, c.width, c.height, 0, 0, 1)).toEqual([1]);
  });

  it('eraser writes the reserved transparent index', () => {
    const c = indexedHarness();
    pencil.onPointerDown(c, 2, 2);
    eraser.onPointerDown(c, 2, 2);
    expect(getPixel(c.buffer, c.width, c.height, 2, 2, 1)).toEqual([TRANSPARENT_INDEX]);
  });

  it('a colour with alpha 0 always resolves to the transparent index, never a palette snap', () => {
    const c = indexedHarness();
    c.primary = [255, 0, 0, 0];
    pencil.onPointerDown(c, 1, 1);
    expect(getPixel(c.buffer, c.width, c.height, 1, 1, 1)).toEqual([TRANSPARENT_INDEX]);
  });

  it('with no palette assigned, painting writes the transparent index rather than throwing', () => {
    const c = harness({ colorMode: 'indexed', palette: undefined, buffer: new Uint8Array(64) });
    pencil.onPointerDown(c, 0, 0);
    expect(getPixel(c.buffer, c.width, c.height, 0, 0, 1)).toEqual([TRANSPARENT_INDEX]);
  });
});
