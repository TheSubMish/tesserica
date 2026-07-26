import { describe, expect, it } from 'vitest';
import { isEmptyRect } from '../model/rect';
import { setPixel } from '../model/pixelBuffers';
import {
  blitRegion,
  deltaMemoryCost,
  diffBounds,
  extractRegion,
  makePixelDelta,
  mergePixelDeltas,
} from './pixelDelta';

const W = 16;
const H = 16;

const blank = () => new Uint8ClampedArray(W * H * 4);

describe('diffBounds', () => {
  it('is empty when the buffers match', () => {
    expect(isEmptyRect(diffBounds(blank(), blank(), W, H))).toBe(true);
  });

  it('is the 1×1 box around a single changed pixel', () => {
    const before = blank();
    const after = blank();
    setPixel(after, W, H, 5, 9, [255, 0, 0, 255]);
    expect(diffBounds(before, after, W, H)).toEqual({ x: 5, y: 9, width: 1, height: 1 });
  });

  it('bounds several scattered pixels', () => {
    const before = blank();
    const after = blank();
    setPixel(after, W, H, 2, 3, [1, 2, 3, 4]);
    setPixel(after, W, H, 11, 4, [1, 2, 3, 4]);
    setPixel(after, W, H, 7, 12, [1, 2, 3, 4]);
    expect(diffBounds(before, after, W, H)).toEqual({ x: 2, y: 3, width: 10, height: 10 });
  });

  it('notices an alpha-only change', () => {
    const before = blank();
    const after = blank();
    // Erasing writes 0,0,0,0 over an opaque black pixel: RGB is unchanged and
    // only alpha moves. Comparing RGB alone would miss the whole eraser.
    setPixel(before, W, H, 1, 1, [0, 0, 0, 255]);
    expect(diffBounds(before, after, W, H)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });
});

describe('extractRegion / blitRegion', () => {
  it('round-trips a sub-rect', () => {
    const buf = blank();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) setPixel(buf, W, H, x, y, [x, y, 0, 255]);
    }
    const rect = { x: 3, y: 4, width: 5, height: 2 };
    const block = extractRegion(buf, W, rect);
    expect(block).toHaveLength(5 * 2 * 4);
    expect([block[0], block[1]]).toEqual([3, 4]);

    const dst = blank();
    blitRegion(dst, W, rect, block);
    expect(extractRegion(dst, W, rect)).toEqual(block);
    // Nothing outside the rect was touched.
    expect(dst[(4 * W + 2) * 4 + 3]).toBe(0);
  });
});

describe('makePixelDelta', () => {
  it('returns null when nothing changed, so no-op clicks make no undo step', () => {
    expect(makePixelDelta('c1', blank(), blank(), W, H)).toBeNull();
  });

  it('stores only the dirty rect, not the whole cel', () => {
    const before = blank();
    const after = blank();
    setPixel(after, W, H, 8, 8, [10, 20, 30, 255]);
    const delta = makePixelDelta('c1', before, after, W, H)!;

    expect(delta.rect).toEqual({ x: 8, y: 8, width: 1, height: 1 });
    // 8 bytes total for a 1px dot on a 16×16 cel, versus 1024 for a snapshot.
    expect(deltaMemoryCost(delta)).toBe(8);
    expect(Array.from(delta.after)).toEqual([10, 20, 30, 255]);
  });
});

describe('mergePixelDeltas', () => {
  it('produces the delta the two edits would have made as one', () => {
    const original = blank();
    setPixel(original, W, H, 0, 0, [9, 9, 9, 255]); // untouched by either edit

    // Edit A.
    const buf = new Uint8ClampedArray(original);
    setPixel(buf, W, H, 2, 2, [255, 0, 0, 255]);
    const a = makePixelDelta('c1', original, buf, W, H)!;

    // Edit B, on a different pixel.
    const mid = new Uint8ClampedArray(buf);
    setPixel(buf, W, H, 6, 5, [0, 255, 0, 255]);
    const b = makePixelDelta('c1', mid, buf, W, H)!;

    const merged = mergePixelDeltas(a, b, buf, W);
    expect(merged.rect).toEqual({ x: 2, y: 2, width: 5, height: 4 });

    // Undoing the merged delta must restore the original exactly, including
    // the pixel that sits inside the union rect but was never edited.
    const undone = new Uint8ClampedArray(buf);
    blitRegion(undone, W, merged.rect, merged.before);
    expect(Array.from(undone)).toEqual(Array.from(original));

    // Redoing it must reproduce the post-B state.
    blitRegion(undone, W, merged.rect, merged.after);
    expect(Array.from(undone)).toEqual(Array.from(buf));
  });

  it('keeps the later value when both edits hit the same pixel', () => {
    const original = blank();
    const buf = new Uint8ClampedArray(original);

    setPixel(buf, W, H, 4, 4, [1, 0, 0, 255]);
    const a = makePixelDelta('c1', original, buf, W, H)!;

    const mid = new Uint8ClampedArray(buf);
    setPixel(buf, W, H, 4, 4, [2, 0, 0, 255]);
    const b = makePixelDelta('c1', mid, buf, W, H)!;

    const merged = mergePixelDeltas(a, b, buf, W);
    expect(Array.from(merged.before)).toEqual([0, 0, 0, 0]);
    expect(Array.from(merged.after)).toEqual([2, 0, 0, 255]);
  });
});
