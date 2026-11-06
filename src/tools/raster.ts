/**
 * Shared rasterization helpers.
 *
 * Bresenham matters more than it looks: pointer events fire every few
 * milliseconds, so a fast drag reports positions many pixels apart. Without
 * interpolating between them a stroke comes out as disconnected dots.
 */

import { TRANSPARENT_INDEX } from '../model/indexBuffers';
import { setPixel } from '../model/pixelBuffers';
import { selectionContains, type Selection } from '../model/selection';
import { footprint, type BrushOptions } from './brush';

/**
 * `clip`, when given, confines painting to a selection (`docs/08-roadmap.md`
 * Phase 3). `undefined`/`null` means "no selection" — paint anywhere, which
 * keeps every pre-existing call site (and its tests) unaffected.
 *
 * `value` is whatever `setPixel` expects: a 4-number RGBA tuple, or a
 * 1-number `[index]` for an indexed-mode cel (`docs/08-roadmap.md` Phase 7)
 * — an `RGBA` is structurally a `readonly number[]`, so every existing
 * rgba-mode call site keeps compiling unchanged.
 */
/**
 * Write one pixel, honouring the ink. `lock-alpha` only recolours pixels that
 * already have coverage and keeps their alpha — so it can never paint onto
 * transparency, and never change how see-through a pixel already is.
 */
function writePixel(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: readonly number[],
  lockAlpha: boolean,
): void {
  if (!lockAlpha) {
    setPixel(buf, width, height, x, y, value);
    return;
  }
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  if (value.length === 1) {
    // Indexed: a transparent pixel is index `TRANSPARENT_INDEX`; leave it alone.
    if (buf[y * width + x] === TRANSPARENT_INDEX) return;
    buf[y * width + x] = value[0];
    return;
  }
  const i = (y * width + x) * 4;
  if (buf[i + 3] === 0) return;
  buf[i] = value[0];
  buf[i + 1] = value[1];
  buf[i + 2] = value[2];
}

export function stampBrush(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  size: number,
  value: readonly number[],
  clip?: Selection | null,
  brush?: BrushOptions,
): void {
  const lockAlpha = brush?.ink === 'lock-alpha';
  if (size <= 1) {
    if (!selectionContains(clip, cx, cy)) return;
    writePixel(buf, width, height, cx, cy, value, lockAlpha);
    return;
  }
  // Centred as well as an even size allows.
  const offset = Math.floor((size - 1) / 2);
  for (const [dx, dy] of footprint(brush?.shape ?? 'square', size)) {
    const x = cx - offset + dx;
    const y = cy - offset + dy;
    if (!selectionContains(clip, x, y)) continue;
    writePixel(buf, width, height, x, y, value, lockAlpha);
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
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  value: readonly number[],
  clip?: Selection | null,
  brush?: BrushOptions,
): void {
  for (const p of linePoints(x0, y0, x1, y1)) {
    stampBrush(buf, width, height, p.x, p.y, size, value, clip, brush);
  }
}
