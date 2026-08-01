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

import { TRANSPARENT_INDEX } from '../model/indexBuffers';
import { getPixel, setPixel } from '../model/pixelBuffers';
import { intersectRect, type Rect } from '../model/rect';
import { selectionContains, type Selection } from '../model/selection';
import type { Tool, ToolContext } from './Tool';

/**
 * Copy of a region's pixels, row-major, `width × height × bpp` bytes. Pixels
 * outside `sel` (when it carries a mask) are left at the "nothing here" value
 * — `0` in every byte, which for RGBA is transparent and for an indexed cel
 * is `TRANSPARENT_INDEX` (`docs/08-roadmap.md` Phase 7) — so `pasteRegion`'s
 * "skip empty source pixels" check naturally leaves them untouched at the
 * destination either way.
 */
function extractRegion(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  bounds: Rect,
  sel: Selection | null,
  bpp: number,
): number[] {
  const out = new Array<number>(bounds.width * bounds.height * bpp).fill(0);
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const gx = bounds.x + x;
      const gy = bounds.y + y;
      if (!selectionContains(sel, gx, gy)) continue;
      const p = getPixel(buf, width, height, gx, gy, bpp);
      if (!p) continue;
      const i = (y * bounds.width + x) * bpp;
      for (let k = 0; k < bpp; k++) out[i + k] = p[k];
    }
  }
  return out;
}

/** Only clears pixels the mask actually selected — never the whole bounding box. */
function clearRegion(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  bounds: Rect,
  sel: Selection | null,
  empty: readonly number[],
): void {
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const gx = bounds.x + x;
      const gy = bounds.y + y;
      if (!selectionContains(sel, gx, gy)) continue;
      setPixel(buf, width, height, gx, gy, empty);
    }
  }
}

function pasteRegion(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  region: readonly number[],
  regionWidth: number,
  regionHeight: number,
  atX: number,
  atY: number,
  bpp: number,
): void {
  for (let y = 0; y < regionHeight; y++) {
    for (let x = 0; x < regionWidth; x++) {
      const i = (y * regionWidth + x) * bpp;
      // The last byte of a pixel is what "empty" means either way: RGBA's
      // alpha, or an indexed cel's one-byte index, since TRANSPARENT_INDEX is
      // `0` too (`model/indexBuffers.ts`).
      if (region[i + bpp - 1] === 0) continue; // nothing to overwrite the destination with
      setPixel(buf, width, height, atX + x, atY + y, region.slice(i, i + bpp));
    }
  }
}

function bppOf(ctx: ToolContext): number {
  return ctx.colorMode === 'indexed' ? 1 : 4;
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
      bppOf(ctx),
    );
  },

  onPointerMove(ctx, x, y) {
    const bounds = ctx.strokeState.bounds as Rect | undefined;
    const original = ctx.strokeState.original as number[] | undefined;
    if (!bounds || !original || bounds.width === 0 || bounds.height === 0) return;

    const bpp = bppOf(ctx);
    const dx = x - ctx.anchor.x;
    const dy = y - ctx.anchor.y;
    ctx.restore();
    // The selection itself does not change mid-gesture (only on pointer-up
    // below), so clearing against the un-translated selection is correct here.
    const empty = bpp === 1 ? [TRANSPARENT_INDEX] : [0, 0, 0, 0];
    clearRegion(ctx.buffer, ctx.width, ctx.height, bounds, ctx.selection, empty);
    pasteRegion(
      ctx.buffer,
      ctx.width,
      ctx.height,
      original,
      bounds.width,
      bounds.height,
      bounds.x + dx,
      bounds.y + dy,
      bpp,
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
