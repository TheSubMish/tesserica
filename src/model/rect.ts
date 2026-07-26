/**
 * Integer rectangles in document space.
 *
 * Dirty rects are the unit of currency for the undo system
 * (`docs/03-data-model.md` §6): a stroke stores the bounding box of the pixels
 * it actually touched, not the whole canvas.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function isEmptyRect(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export function rectArea(r: Rect): number {
  return isEmptyRect(r) ? 0 : r.width * r.height;
}

export function unionRect(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return isEmptyRect(b) ? EMPTY_RECT : { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return EMPTY_RECT;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}

/** Grow a rect to include a point. An empty rect becomes the 1×1 point rect. */
export function growRect(r: Rect, x: number, y: number): Rect {
  return unionRect(r, { x, y, width: 1, height: 1 });
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
