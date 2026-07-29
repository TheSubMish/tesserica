/**
 * Move — translate the selection's contents, or the whole cel when nothing is
 * selected (`docs/08-roadmap.md` Phase 3 — "selection tools + move").
 *
 * Previews the same way line/rect/ellipse do (`line.ts`): restore the cel to
 * its pointer-down state and redraw from scratch on every move, rather than
 * accumulating a translation onto the live buffer. That is what keeps a fast,
 * jittery drag from smearing copies of the moved region across the canvas.
 *
 * Respects a non-rectangular selection's mask: extracting and clearing only
 * touch pixels the mask actually selects, so moving an ellipse or lasso
 * selection does not disturb the rest of its bounding box.
 */

import { getPixel, setPixel } from '../model/pixelBuffers';
import { intersectRect, type Rect } from '../model/rect';
import { selectionContains, type Selection } from '../model/selection';
import type { Tool } from './Tool';

/**
 * Copy of a region's pixels, row-major, `width × height × 4` bytes. Pixels
 * outside `sel` (when it carries a mask) are left as transparent zero, so
 * `pasteRegion`'s "skip zero-alpha" check naturally leaves them untouched at
 * the destination.
 */
function extractRegion(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: Rect,
  sel: Selection | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const gx = bounds.x + x;
      const gy = bounds.y + y;
      if (!selectionContains(sel, gx, gy)) continue;
      const p = getPixel(buf, width, height, gx, gy) ?? [0, 0, 0, 0];
      const i = (y * bounds.width + x) * 4;
      out.set(p, i);
    }
  }
  return out;
}

/** Only clears pixels the mask actually selected — never the whole bounding box. */
function clearRegion(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: Rect,
  sel: Selection | null,
): void {
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const gx = bounds.x + x;
      const gy = bounds.y + y;
      if (!selectionContains(sel, gx, gy)) continue;
      setPixel(buf, width, height, gx, gy, [0, 0, 0, 0]);
    }
  }
}

function pasteRegion(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  region: Uint8ClampedArray,
  regionWidth: number,
  regionHeight: number,
  atX: number,
  atY: number,
): void {
  for (let y = 0; y < regionHeight; y++) {
    for (let x = 0; x < regionWidth; x++) {
      const i = (y * regionWidth + x) * 4;
      if (region[i + 3] === 0) continue; // nothing to overwrite the destination with
      setPixel(buf, width, height, atX + x, atY + y, [
        region[i],
        region[i + 1],
        region[i + 2],
        region[i + 3],
      ]);
    }
  }
}

export const move: Tool = {
  id: 'move',
  label: 'Move',

  onPointerDown(ctx) {
    const full: Rect = { x: 0, y: 0, width: ctx.width, height: ctx.height };
    const bounds = intersectRect(ctx.selection?.bounds ?? full, full);
    ctx.strokeState.bounds = bounds;
    ctx.strokeState.original = extractRegion(
      ctx.buffer,
      ctx.width,
      ctx.height,
      bounds,
      ctx.selection,
    );
  },

  onPointerMove(ctx, x, y) {
    const bounds = ctx.strokeState.bounds as Rect | undefined;
    const original = ctx.strokeState.original as Uint8ClampedArray | undefined;
    if (!bounds || !original || bounds.width === 0 || bounds.height === 0) return;

    const dx = x - ctx.anchor.x;
    const dy = y - ctx.anchor.y;
    ctx.restore();
    // The selection itself does not change mid-gesture (only on pointer-up
    // below), so clearing against the un-translated selection is correct here.
    clearRegion(ctx.buffer, ctx.width, ctx.height, bounds, ctx.selection);
    pasteRegion(
      ctx.buffer,
      ctx.width,
      ctx.height,
      original,
      bounds.width,
      bounds.height,
      bounds.x + dx,
      bounds.y + dy,
    );
  },

  onPointerUp(ctx, x, y) {
    // The selection tracks what it moved, so a second drag continues from
    // where the first left off rather than snapping back to the original spot.
    const bounds = ctx.strokeState.bounds as Rect | undefined;
    if (!bounds || !ctx.selection) return;
    const dx = x - ctx.anchor.x;
    const dy = y - ctx.anchor.y;
    if (dx !== 0 || dy !== 0) {
      const sel = ctx.selection;
      ctx.setSelection({
        ...sel,
        bounds: { ...sel.bounds, x: sel.bounds.x + dx, y: sel.bounds.y + dy },
      });
    }
  },
};
