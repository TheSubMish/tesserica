/**
 * Dirty-rect pixel deltas — the storage format for every drawing undo step
 * (`docs/03-data-model.md` §6).
 *
 * "A 3-pixel dot on a 512×512 canvas costs ~100 bytes, not 1 MB." That is the
 * whole point of this file: a stroke is recorded as the bounding box of the
 * pixels that genuinely changed, plus the before/after bytes for exactly that
 * box.
 *
 * How the bounding box is found matters for cost. Tracking it inside every
 * tool would mean threading a recorder through `setPixel`; instead the stroke
 * recorder takes **one** copy of the cel at pointer-down, lets the tool draw
 * freely, and diffs at pointer-up. One copy per gesture, not per pointer
 * event — and the resulting rect is exact for any tool, including flood fill.
 */

import type { CelId } from '../model/types';
import { EMPTY_RECT, isEmptyRect, unionRect, type Rect } from '../model/rect';

export interface PixelDelta {
  celId: CelId;
  /** Cel-local coordinates. */
  rect: Rect;
  /** RGBA bytes for `rect`, before the edit. */
  before: Uint8ClampedArray;
  /** RGBA bytes for `rect`, after the edit. */
  after: Uint8ClampedArray;
}

/** Bounding box of the pixels that differ between two same-sized buffers. */
export function diffBounds(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
): Rect {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] ||
        before[i + 3] !== after[i + 3]
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return EMPTY_RECT;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copy `rect` out of a full-cel buffer into a tightly packed RGBA block. */
export function extractRegion(
  buf: Uint8ClampedArray,
  bufWidth: number,
  rect: Rect,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const src = ((rect.y + row) * bufWidth + rect.x) * 4;
    out.set(buf.subarray(src, src + rect.width * 4), row * rect.width * 4);
  }
  return out;
}

/** Write a tightly packed RGBA block back into a full-cel buffer at `rect`. */
export function blitRegion(
  buf: Uint8ClampedArray,
  bufWidth: number,
  rect: Rect,
  data: Uint8ClampedArray,
): void {
  for (let row = 0; row < rect.height; row++) {
    const dst = ((rect.y + row) * bufWidth + rect.x) * 4;
    const src = row * rect.width * 4;
    buf.set(data.subarray(src, src + rect.width * 4), dst);
  }
}

/**
 * Build a delta from a pre-edit snapshot and the current buffer. Returns
 * `null` when nothing actually changed, so a click that repaints an identical
 * pixel does not create an undo step.
 */
export function makePixelDelta(
  celId: CelId,
  before: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
): PixelDelta | null {
  const rect = diffBounds(before, current, width, height);
  if (isEmptyRect(rect)) return null;
  return {
    celId,
    rect,
    before: extractRegion(before, width, rect),
    after: extractRegion(current, width, rect),
  };
}

export function deltaMemoryCost(delta: PixelDelta): number {
  return delta.before.byteLength + delta.after.byteLength;
}

/**
 * Merge delta `b` (applied after `a`, on the same cel) into a single delta
 * covering the union of both rects.
 *
 * `current` must be the buffer in its post-`b` state, which is how coalescing
 * is always called: the second command has just been applied. The union rect
 * can include pixels touched by neither delta, and those pixels are identical
 * before and after — reading them from `current` gives the correct value for
 * both sides.
 */
export function mergePixelDeltas(
  a: PixelDelta,
  b: PixelDelta,
  current: Uint8ClampedArray,
  bufWidth: number,
): PixelDelta {
  const rect = unionRect(a.rect, b.rect);

  // `after` is simply the present state over the union.
  const after = extractRegion(current, bufWidth, rect);

  // `before` is rebuilt by walking backwards: present → undo b → undo a.
  const scratch = new Uint8ClampedArray(current);
  blitRegion(scratch, bufWidth, b.rect, b.before);
  blitRegion(scratch, bufWidth, a.rect, a.before);
  const before = extractRegion(scratch, bufWidth, rect);

  return { celId: a.celId, rect, before, after };
}
