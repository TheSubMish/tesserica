import type { Tool, ToolContext } from './Tool';
import { drawLine, stampBrush } from './raster';

const TRANSPARENT = [0, 0, 0, 0] as const;

function colorFor(ctx: ToolContext) {
  return ctx.button === 2 ? ctx.secondary : ctx.primary;
}

export const pencil: Tool = {
  id: 'pencil',
  onPointerDown(ctx, x, y) {
    stampBrush(ctx.buffer, ctx.width, ctx.height, x, y, ctx.brushSize, colorFor(ctx));
  },
  onPointerMove(ctx, x, y, prevX, prevY) {
    drawLine(ctx.buffer, ctx.width, ctx.height, prevX, prevY, x, y, ctx.brushSize, colorFor(ctx));
  },
};

export const eraser: Tool = {
  id: 'eraser',
  onPointerDown(ctx, x, y) {
    stampBrush(ctx.buffer, ctx.width, ctx.height, x, y, ctx.brushSize, TRANSPARENT);
  },
  onPointerMove(ctx, x, y, prevX, prevY) {
    drawLine(ctx.buffer, ctx.width, ctx.height, prevX, prevY, x, y, ctx.brushSize, TRANSPARENT);
  },
};
