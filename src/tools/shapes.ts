/**
 * Rectangle and ellipse rasterization.
 *
 * The ellipse uses the **midpoint algorithm** (`docs/05-ui-design.md` §4.1),
 * not a scaled circle. Scaling a circle produces non-uniform stroke thickness
 * and duplicated pixels at the flat parts of the arc — immediately visible at
 * pixel-art sizes, which is the whole reason the doc calls it out.
 */

import { setPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import type { Point } from './raster';

/** Two dragged corners → an inclusive, normalized rect in cel coordinates. */
export function normalizeDrag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

export function drawRect(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGBA,
  filled: boolean,
): void {
  const { left, top, right, bottom } = normalizeDrag(x0, y0, x1, y1);

  if (filled) {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) setPixel(buf, width, height, x, y, color);
    }
    return;
  }

  for (let x = left; x <= right; x++) {
    setPixel(buf, width, height, x, top, color);
    setPixel(buf, width, height, x, bottom, color);
  }
  for (let y = top; y <= bottom; y++) {
    setPixel(buf, width, height, left, y, color);
    setPixel(buf, width, height, right, y, color);
  }
}

/**
 * Midpoint ellipse inscribed in the dragged box, in pure integer arithmetic
 * (Bresenham/Zingl rectangular formulation).
 *
 * The rectangular form is what makes even-sized boxes come out symmetric: a
 * 4-wide box has its centre on a pixel *boundary*, and a radius-and-centre
 * formulation would have to round that to a pixel centre, biasing the shape
 * one column over.
 */
export function ellipsePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const { left, top, right, bottom } = normalizeDrag(x0, y0, x1, y1);
  const points: Point[] = [];
  const seen = new Set<string>();

  const plot = (x: number, y: number) => {
    if (x < left || x > right || y < top || y > bottom) return;
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ x, y });
  };

  const a = right - left; // horizontal diameter
  const b = bottom - top; // vertical diameter

  // Degenerate drags are lines, and the general loop does not handle a zero
  // diameter.
  if (a === 0) {
    for (let y = top; y <= bottom; y++) plot(left, y);
    return points;
  }
  if (b === 0) {
    for (let x = left; x <= right; x++) plot(x, top);
    return points;
  }

  const b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;

  let xl = left;
  let xr = right;
  let yt = top + ((b + 1) >> 1);
  let yb = yt - b1;
  const stepY = 8 * a * a;
  const stepX = 8 * b * b;

  do {
    plot(xr, yt);
    plot(xl, yt);
    plot(xl, yb);
    plot(xr, yb);
    const e2 = 2 * err;
    if (e2 >= dx) {
      xl++;
      xr--;
      dx += stepX;
      err += dx;
    }
    if (e2 <= dy) {
      yt++;
      yb--;
      dy += stepY;
      err += dy;
    }
  } while (xl <= xr);

  // Flat ellipses stop the loop early; finish the tips.
  while (yt - yb <= b) {
    plot(xl - 1, yt);
    plot(xr + 1, yt);
    yt++;
    plot(xl - 1, yb);
    plot(xr + 1, yb);
    yb--;
  }

  return points;
}

export function drawEllipse(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGBA,
  filled: boolean,
): void {
  const points = ellipsePoints(x0, y0, x1, y1);

  if (!filled) {
    for (const p of points) setPixel(buf, width, height, p.x, p.y, color);
    return;
  }

  // Fill by spanning between the outline's extremes on each row. Scanline
  // filling the outline itself keeps the filled and outlined shapes identical
  // at the edge, which matters when a user draws one on top of the other.
  const rows = new Map<number, { min: number; max: number }>();
  for (const p of points) {
    const row = rows.get(p.y);
    if (!row) rows.set(p.y, { min: p.x, max: p.x });
    else {
      if (p.x < row.min) row.min = p.x;
      if (p.x > row.max) row.max = p.x;
    }
  }
  for (const [y, row] of rows) {
    for (let x = row.min; x <= row.max; x++) setPixel(buf, width, height, x, y, color);
  }
}
