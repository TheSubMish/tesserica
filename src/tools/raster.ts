/**
 * Shared rasterization helpers.
 *
 * Bresenham matters more than it looks: pointer events fire every few
 * milliseconds, so a fast drag reports positions many pixels apart. Without
 * interpolating between them a stroke comes out as disconnected dots.
 */

import { setPixel } from '../model/pixelBuffers';
import { selectionContains, type Selection } from '../model/selection';
import type { RGBA } from '../model/types';

/**
 * `clip`, when given, confines painting to a selection (`docs/08-roadmap.md`
 * Phase 3). `undefined`/`null` means "no selection" — paint anywhere, which
 * keeps every pre-existing call site (and its tests) unaffected.
 */
export function stampBrush(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  size: number,
  color: RGBA,
  clip?: Selection | null,
): void {
  if (size <= 1) {
    if (!selectionContains(clip, cx, cy)) return;
    setPixel(buf, width, height, cx, cy, color);
    return;
  }
  // Square brush, centered as well as an even size allows.
  const offset = Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x = cx - offset + dx;
      const y = cy - offset + dy;
      if (!selectionContains(clip, x, y)) continue;
      setPixel(buf, width, height, x, y, color);
    }
  }
}

export type Point = { x: number; y: number };

/**
 * The cells a Bresenham line passes through, from `(x0,y0)` to `(x1,y1)`
 * inclusive.
 *
 * Returned as a list rather than drawn directly because pixel-perfect mode has
 * to inspect the *sequence* of cells, not just their union.
 */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

/** Bresenham line, stamping the brush at every step. */
export function drawLine(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  color: RGBA,
  clip?: Selection | null,
): void {
  for (const p of linePoints(x0, y0, x1, y1)) {
    stampBrush(buf, width, height, p.x, p.y, size, color, clip);
  }
}
