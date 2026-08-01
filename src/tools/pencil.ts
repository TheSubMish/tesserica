/**
 * Pencil, with pixel-perfect mode on by default (`docs/05-ui-design.md` §4.1).
 *
 * **Why pixel-perfect matters.** A freehand diagonal drawn with Bresenham
 * produces L-shaped corners — three pixels where the eye expects two — and at
 * pixel-art scale that reads as a lumpy, doubled line. Pixel-perfect mode
 * watches the last three cells of the stroke and, when the first and third are
 * diagonal neighbours, retracts the middle one. It has to run *during* the
 * stroke rather than as a cleanup pass, because the user is judging the line
 * as they draw it.
 *
 * Only meaningful at brush size 1: a wider brush has no single corner pixel to
 * retract.
 */

import type { Tool, ToolContext } from './Tool';
import { linePoints, stampBrush, type Point } from './raster';
import { pixelValueFor } from './pixelValue';
import type { RGBA } from '../model/types';

export function colorFor(ctx: ToolContext): RGBA {
  return ctx.button === 2 ? ctx.secondary : ctx.primary;
}

/** The cells drawn so far in this stroke, after pixel-perfect retraction. */
function trail(ctx: ToolContext): Point[] {
  const existing = ctx.strokeState.trail as Point[] | undefined;
  if (existing) return existing;
  const fresh: Point[] = [];
  ctx.strokeState.trail = fresh;
  return fresh;
}

/** True when `b` is a redundant corner between diagonal neighbours `a` and `c`. */
export function isRedundantCorner(a: Point, b: Point, c: Point): boolean {
  const diagonal = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
  const bTouchesA = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  const bTouchesC = Math.abs(c.x - b.x) + Math.abs(c.y - b.y) === 1;
  return diagonal && bTouchesA && bTouchesC;
}

function plot(ctx: ToolContext, x: number, y: number, color: RGBA): void {
  stampBrush(
    ctx.buffer,
    ctx.width,
    ctx.height,
    x,
    y,
    ctx.brushSize,
    pixelValueFor(ctx, color),
    ctx.selection,
  );

  if (!ctx.pixelPerfect || ctx.brushSize > 1) return;

  const pts = trail(ctx);
  const prev = pts[pts.length - 1];
  if (prev && prev.x === x && prev.y === y) return;
  pts.push({ x, y });

  if (pts.length < 3) return;
  const [a, b, c] = pts.slice(-3);
  if (isRedundantCorner(a, b, c)) {
    ctx.restorePixel(b.x, b.y);
    pts.splice(pts.length - 2, 1);
  }
}

export const pencil: Tool = {
  id: 'pencil',
  label: 'Pencil',

  onPointerDown(ctx, x, y) {
    plot(ctx, x, y, colorFor(ctx));
  },

  onPointerMove(ctx, x, y, prevX, prevY) {
    const color = colorFor(ctx);
    // Skip the first point: it is the previous event's position and has
    // already been plotted. Re-plotting it would let a retracted corner
    // reappear.
    for (const p of linePoints(prevX, prevY, x, y).slice(1)) plot(ctx, p.x, p.y, color);
  },
};
