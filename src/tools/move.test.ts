import { describe, expect, it } from 'vitest';
import { getPixel, setPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import { move } from './move';
import { harness } from './testHarness';

const RED: RGBA = [255, 0, 0, 255];
const W = 8;
const H = 8;

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4);
}

describe('move tool', () => {
  it('translates the whole cel when nothing is selected', () => {
    const buf = blank();
    setPixel(buf, W, H, 0, 0, RED);
    const c = harness({ buffer: buf, width: W, height: H, anchor: { x: 0, y: 0 } });
    c.snapshot();

    move.onPointerDown(c, 0, 0);
    move.onPointerMove(c, 2, 3, 0, 0);

    expect(getPixel(c.buffer, W, H, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(getPixel(c.buffer, W, H, 2, 3)).toEqual(RED);
  });

  it('moves only the selected region, leaving the rest of the cel alone', () => {
    const buf = blank();
    setPixel(buf, W, H, 1, 1, RED);
    setPixel(buf, W, H, 6, 6, [0, 0, 255, 255]);
    const c = harness({
      buffer: buf,
      width: W,
      height: H,
      anchor: { x: 1, y: 1 },
      selection: { bounds: { x: 0, y: 0, width: 4, height: 4 } },
    });
    c.snapshot();

    move.onPointerDown(c, 1, 1);
    move.onPointerMove(c, 3, 3, 1, 1);

    // The selected pixel moved by (2,2)...
    expect(getPixel(c.buffer, W, H, 3, 3)).toEqual(RED);
    expect(getPixel(c.buffer, W, H, 1, 1)).toEqual([0, 0, 0, 0]);
    // ...and the untouched pixel outside the selection is undisturbed.
    expect(getPixel(c.buffer, W, H, 6, 6)).toEqual([0, 0, 255, 255]);
  });

  it('respects a masked selection — pixels inside the bounding box but outside the mask stay put', () => {
    const buf = blank();
    setPixel(buf, W, H, 1, 1, RED); // inside the mask
    setPixel(buf, W, H, 0, 0, [0, 0, 255, 255]); // inside the bounding box, outside the mask
    // A 2×2 mask over a 2×2 bounding box, but only the (1,1) corner selected.
    const mask = new Uint8Array([0, 0, 0, 1]);
    const c = harness({
      buffer: buf,
      width: W,
      height: H,
      anchor: { x: 1, y: 1 },
      selection: { bounds: { x: 0, y: 0, width: 2, height: 2 }, mask },
    });
    c.snapshot();

    move.onPointerDown(c, 1, 1);
    move.onPointerMove(c, 4, 4, 1, 1);

    expect(getPixel(c.buffer, W, H, 4, 4)).toEqual(RED);
    expect(getPixel(c.buffer, W, H, 1, 1)).toEqual([0, 0, 0, 0]);
    // The blue pixel was never part of the selection — untouched, not cleared.
    expect(getPixel(c.buffer, W, H, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('redraws from the pointer-down snapshot rather than accumulating drift', () => {
    // Drag right, then reverse — a naive "add the delta" implementation would
    // leave a smear; restoring first must not.
    const buf = blank();
    setPixel(buf, W, H, 0, 0, RED);
    const c = harness({ buffer: buf, width: W, height: H, anchor: { x: 0, y: 0 } });
    c.snapshot();

    move.onPointerDown(c, 0, 0);
    move.onPointerMove(c, 5, 0, 0, 0);
    move.onPointerMove(c, 1, 0, 5, 0);

    expect(getPixel(c.buffer, W, H, 1, 0)).toEqual(RED);
    expect(getPixel(c.buffer, W, H, 5, 0)).toEqual([0, 0, 0, 0]);
  });

  it('advances the selection so a second drag continues from the new spot', () => {
    const c = harness({
      buffer: blank(),
      width: W,
      height: H,
      anchor: { x: 0, y: 0 },
      selection: { bounds: { x: 0, y: 0, width: 2, height: 2 } },
    });
    c.snapshot();

    move.onPointerDown(c, 0, 0);
    move.onPointerMove(c, 3, 1, 0, 0);
    move.onPointerUp?.(c, 3, 1);

    expect(c.selection).toEqual({ bounds: { x: 3, y: 1, width: 2, height: 2 } });
  });

  it('leaves the selection alone when the pointer never moved', () => {
    const original = { bounds: { x: 0, y: 0, width: 2, height: 2 } };
    const c = harness({
      buffer: blank(),
      width: W,
      height: H,
      anchor: { x: 0, y: 0 },
      selection: original,
    });
    c.snapshot();

    move.onPointerDown(c, 0, 0);
    move.onPointerUp?.(c, 0, 0);

    expect(c.selection).toEqual(original);
  });
});

describe('move tool — indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  it('translates palette indices, not RGBA bytes', () => {
    const buf = new Uint8Array(W * H);
    setPixel(buf, W, H, 0, 0, [3]);
    const c = harness({
      colorMode: 'indexed',
      buffer: buf,
      width: W,
      height: H,
      anchor: { x: 0, y: 0 },
    });
    c.snapshot();

    move.onPointerDown(c, 0, 0);
    move.onPointerMove(c, 2, 3, 0, 0);

    expect(getPixel(c.buffer, W, H, 0, 0, 1)).toEqual([0]);
    expect(getPixel(c.buffer, W, H, 2, 3, 1)).toEqual([3]);
  });
});
