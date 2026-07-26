/**
 * Line, rectangle and ellipse — the drag-to-define shapes.
 *
 * All three preview by *actually drawing into the cel*: restore the cel to its
 * pointer-down state, draw the shape at the current cursor, repeat. The
 * preview is therefore the exact pixels that will be committed, and the undo
 * step comes out of the same diff that every other tool uses — no separate
 * overlay, no second rasterizer to keep in step with the first.
 */

import type { Tool } from './Tool';
import { drawLine } from './raster';
import { drawEllipse, drawRect } from './shapes';
import { colorFor } from './pencil';

export const line: Tool = {
  id: 'line',
  label: 'Line',
  onPointerDown(ctx, x, y) {
    drawLine(ctx.buffer, ctx.width, ctx.height, x, y, x, y, ctx.brushSize, colorFor(ctx));
  },
  onPointerMove(ctx, x, y) {
    ctx.restore();
    drawLine(
      ctx.buffer,
      ctx.width,
      ctx.height,
      ctx.anchor.x,
      ctx.anchor.y,
      x,
      y,
      ctx.brushSize,
      colorFor(ctx),
    );
  },
};

export const rectangle: Tool = {
  id: 'rect',
  label: 'Rectangle',
  onPointerDown(ctx, x, y) {
    drawRect(ctx.buffer, ctx.width, ctx.height, x, y, x, y, colorFor(ctx), ctx.shapeFill);
  },
  onPointerMove(ctx, x, y) {
    ctx.restore();
    drawRect(
      ctx.buffer,
      ctx.width,
      ctx.height,
      ctx.anchor.x,
      ctx.anchor.y,
      x,
      y,
      colorFor(ctx),
      ctx.shapeFill,
    );
  },
};

export const ellipse: Tool = {
  id: 'ellipse',
  label: 'Ellipse',
  onPointerDown(ctx, x, y) {
    drawEllipse(ctx.buffer, ctx.width, ctx.height, x, y, x, y, colorFor(ctx), ctx.shapeFill);
  },
  onPointerMove(ctx, x, y) {
    ctx.restore();
    drawEllipse(
      ctx.buffer,
      ctx.width,
      ctx.height,
      ctx.anchor.x,
      ctx.anchor.y,
      x,
      y,
      colorFor(ctx),
      ctx.shapeFill,
    );
  },
};
