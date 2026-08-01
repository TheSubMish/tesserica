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
 *
 * `bytesPerPixel` defaults to 4 (RGBA) everywhere below, so every pre-Phase-7
 * call site is unaffected; an indexed-mode cel (`docs/08-roadmap.md` Phase 7,
 * `model/celStorage.ts`) passes 1. A given cel id always uses the same value
 * for its whole life (a sprite's `colorMode` is fixed at creation), so a
 * delta never needs to reconcile two different bpp values against each
 * other.
 */

import type { CelId } from '../model/types';
import { EMPTY_RECT, isEmptyRect, unionRect, type Rect } from '../model/rect';

type CelBuffer = Uint8ClampedArray | Uint8Array;

export interface PixelDelta {
  celId: CelId;
  /** Cel-local coordinates. */
  rect: Rect;
  /** Bytes for `rect`, before the edit — RGBA (4/px) or palette indices (1/px). */
  before: CelBuffer;
  /** Bytes for `rect`, after the edit. */
  after: CelBuffer;
  /** How `before`/`after` are laid out — see the module comment above. */
  bytesPerPixel: number;
}

/** Bounding box of the pixels that differ between two same-sized buffers. */
export function diffBounds(
  before: CelBuffer,
  after: CelBuffer,
  width: number,
  height: number,
  bytesPerPixel = 4,
): Rect {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * bytesPerPixel;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * bytesPerPixel;
      let differs = false;
      for (let k = 0; k < bytesPerPixel; k++) {
        if (before[i + k] !== after[i + k]) {
          differs = true;
          break;
        }
      }
      if (differs) {
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

/**
 * Copy `rect` out of a full-cel buffer into a tightly packed block.
 *
 * Generic over the concrete buffer type so a caller holding a
 * `Uint8ClampedArray` (every pre-Phase-7 call site) gets a `Uint8ClampedArray`
 * back, not the widened `CelBuffer` union — `canvas/applyTransform.ts` feeds
 * the result straight into RGBA-only functions and would otherwise need a
 * cast at every call site.
 */
export function extractRegion<T extends CelBuffer>(
  buf: T,
  bufWidth: number,
  rect: Rect,
  bytesPerPixel = 4,
): T {
  const out = (
    buf instanceof Uint8ClampedArray
      ? new Uint8ClampedArray(rect.width * rect.height * bytesPerPixel)
      : new Uint8Array(rect.width * rect.height * bytesPerPixel)
  ) as T;
  for (let row = 0; row < rect.height; row++) {
    const src = ((rect.y + row) * bufWidth + rect.x) * bytesPerPixel;
    out.set(buf.subarray(src, src + rect.width * bytesPerPixel), row * rect.width * bytesPerPixel);
  }
  return out;
}

/** Write a tightly packed block back into a full-cel buffer at `rect`. */
export function blitRegion(
  buf: CelBuffer,
  bufWidth: number,
  rect: Rect,
  data: CelBuffer,
  bytesPerPixel = 4,
): void {
  for (let row = 0; row < rect.height; row++) {
    const dst = ((rect.y + row) * bufWidth + rect.x) * bytesPerPixel;
    const src = row * rect.width * bytesPerPixel;
    buf.set(data.subarray(src, src + rect.width * bytesPerPixel), dst);
  }
}

/**
 * Build a delta from a pre-edit snapshot and the current buffer. Returns
 * `null` when nothing actually changed, so a click that repaints an identical
 * pixel does not create an undo step.
 */
export function makePixelDelta(
  celId: CelId,
  before: CelBuffer,
  current: CelBuffer,
  width: number,
  height: number,
  bytesPerPixel = 4,
): PixelDelta | null {
  const rect = diffBounds(before, current, width, height, bytesPerPixel);
  if (isEmptyRect(rect)) return null;
  return {
    celId,
    rect,
    before: extractRegion(before, width, rect, bytesPerPixel),
    after: extractRegion(current, width, rect, bytesPerPixel),
    bytesPerPixel,
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
  current: CelBuffer,
  bufWidth: number,
): PixelDelta {
  const bytesPerPixel = a.bytesPerPixel;
  const rect = unionRect(a.rect, b.rect);

  // `after` is simply the present state over the union.
  const after = extractRegion(current, bufWidth, rect, bytesPerPixel);

  // `before` is rebuilt by walking backwards: present → undo b → undo a.
  const scratch = current.slice();
  blitRegion(scratch, bufWidth, b.rect, b.before, bytesPerPixel);
  blitRegion(scratch, bufWidth, a.rect, a.before, bytesPerPixel);
  const before = extractRegion(scratch, bufWidth, rect, bytesPerPixel);

  return { celId: a.celId, rect, before, after, bytesPerPixel };
}
