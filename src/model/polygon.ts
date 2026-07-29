/**
 * Freehand-lasso polygon rasterization (`docs/08-roadmap.md` Phase 3 —
 * "selection tools ... lasso").
 *
 * A standard scanline fill: for every pixel row, intersect the (implicitly
 * closed) polygon edges with the horizontal line through the row's centre,
 * sort the crossings, and fill the spans between consecutive pairs
 * (even-odd rule). This is the same algorithm most vector-fill renderers use,
 * just rasterized onto the pixel grid instead of anti-aliased.
 */

import { selectionFromMask, type Selection } from './selection';

export interface Point {
  x: number;
  y: number;
}

/**
 * Rasterize a freehand path into a `Selection`. The path is implicitly closed
 * (last point connects back to the first), matching every reference editor's
 * lasso. Returns `null` for a degenerate path (fewer than 3 distinct points)
 * or one that encloses no pixels.
 */
export function polygonSelection(points: Point[]): Selection | null {
  if (points.length < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const left = Math.floor(minX);
  const top = Math.floor(minY);
  const width = Math.floor(maxX) - left + 1;
  const height = Math.floor(maxY) - top + 1;
  if (width <= 0 || height <= 0) return null;

  const mask = new Uint8Array(width * height);
  const n = points.length;

  for (let row = 0; row < height; row++) {
    const y = top + row + 0.5; // sample at the pixel centre
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y === b.y) continue; // horizontal edges never cross a scanline
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (y < lo || y >= hi) continue;
      const t = (y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);

    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(left, Math.round(xs[i]));
      const xEnd = Math.min(left + width - 1, Math.ceil(xs[i + 1]) - 1);
      for (let x = xStart; x <= xEnd; x++) {
        mask[row * width + (x - left)] = 1;
      }
    }
  }

  return selectionFromMask({ x: left, y: top, width, height }, mask);
}
