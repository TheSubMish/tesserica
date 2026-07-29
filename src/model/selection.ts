/**
 * The active selection (`docs/08-roadmap.md` Phase 3 — "selection tools +
 * move").
 *
 * A selection is a bounding `Rect` plus an optional `mask` — a row-major
 * `Uint8Array` over that rect, `1` meaning "selected". The mask is omitted for
 * the common case (a plain rectangular marquee): every pixel in `bounds` is
 * selected, and no allocation is needed. Ellipse, lasso and magic-wand
 * selections always carry a mask, since their shape cannot be expressed as a
 * rect alone.
 *
 * Document-space, not layer-space — a selection outlives whichever layer was
 * active when it was drawn, the same way it does in every reference editor.
 * Kept separate from `documentStore` because a selection is not part of the
 * document: it does not save into `.tess` and does not participate in undo.
 */

import { isEmptyRect, rectContains, type Rect } from './rect';

export interface Selection {
  bounds: Rect;
  /**
   * Row-major over `bounds`, `1` = selected. `undefined` means "every pixel in
   * `bounds` is selected" — the rectangle fast path.
   */
  mask?: Uint8Array;
}

/** A plain rectangular selection — no mask needed. */
export function rectSelection(bounds: Rect): Selection {
  return { bounds };
}

/** True when `(x, y)` is part of the selection. `null`/`undefined` selects everywhere. */
export function selectionContains(
  sel: Selection | null | undefined,
  x: number,
  y: number,
): boolean {
  if (!sel) return true;
  if (!rectContains(sel.bounds, x, y)) return false;
  if (!sel.mask) return true;
  const lx = x - sel.bounds.x;
  const ly = y - sel.bounds.y;
  return sel.mask[ly * sel.bounds.width + lx] === 1;
}

/**
 * Build a `Selection` from a mask over `bounds`, trimming to the tight
 * bounding box of the `1`s actually present. Keeps `Move`'s extracted region —
 * and the marching-ants edge walk — no bigger than the shape needs.
 *
 * Returns `null` when the mask selects nothing.
 */
export function selectionFromMask(bounds: Rect, mask: Uint8Array): Selection | null {
  let minX = bounds.width;
  let minY = bounds.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      if (mask[y * bounds.width + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const tight = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      tight[y * tw + x] = mask[(y + minY) * bounds.width + (x + minX)];
    }
  }
  return { bounds: { x: bounds.x + minX, y: bounds.y + minY, width: tw, height: th }, mask: tight };
}

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Grid-aligned boundary edges of a selection, in document pixel space (not
 * yet scaled to screen). Used to draw marching ants around any shape, not
 * just a rectangle: every selected cell contributes an edge for each side
 * that borders an unselected (or out-of-bounds) cell.
 */
export function selectionEdges(sel: Selection): Segment[] {
  const { bounds, mask } = sel;
  if (isEmptyRect(bounds)) return [];

  if (!mask) {
    const { x, y, width, height } = bounds;
    return [
      { x0: x, y0: y, x1: x + width, y1: y },
      { x0: x + width, y0: y, x1: x + width, y1: y + height },
      { x0: x + width, y0: y + height, x1: x, y1: y + height },
      { x0: x, y0: y + height, x1: x, y1: y },
    ];
  }

  const at = (lx: number, ly: number): boolean =>
    lx >= 0 &&
    ly >= 0 &&
    lx < bounds.width &&
    ly < bounds.height &&
    mask[ly * bounds.width + lx] === 1;

  const segs: Segment[] = [];
  for (let ly = 0; ly < bounds.height; ly++) {
    for (let lx = 0; lx < bounds.width; lx++) {
      if (!at(lx, ly)) continue;
      const gx = bounds.x + lx;
      const gy = bounds.y + ly;
      if (!at(lx, ly - 1)) segs.push({ x0: gx, y0: gy, x1: gx + 1, y1: gy });
      if (!at(lx, ly + 1)) segs.push({ x0: gx, y0: gy + 1, x1: gx + 1, y1: gy + 1 });
      if (!at(lx - 1, ly)) segs.push({ x0: gx, y0: gy, x1: gx, y1: gy + 1 });
      if (!at(lx + 1, ly)) segs.push({ x0: gx + 1, y0: gy, x1: gx + 1, y1: gy + 1 });
    }
  }
  return segs;
}
