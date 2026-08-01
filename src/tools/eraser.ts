/**
 * Eraser — writes fully transparent pixels.
 *
 * Straight alpha means erasing is a plain write of `0,0,0,0`, not a blend
 * (`docs/02-architecture.md` §9). Clearing RGB along with alpha keeps
 * transparent pixels from carrying a stale colour that a later downscale or
 * quantization step could bleed back in.
 */

import type { Tool } from './Tool';
import { drawLine, stampBrush } from './raster';
import { pixelValueFor } from './pixelValue';
import type { RGBA } from '../model/types';

const TRANSPARENT: RGBA = [0, 0, 0, 0];

export const eraser: Tool = {
  id: 'eraser',
  label: 'Eraser',
  onPointerDown(ctx, x, y) {
    stampBrush(
      ctx.buffer,
      ctx.width,
      ctx.height,
      x,
      y,
      ctx.brushSize,
      pixelValueFor(ctx, TRANSPARENT),
      ctx.selection,
    );
  },
  onPointerMove(ctx, x, y, prevX, prevY) {
    drawLine(
      ctx.buffer,
      ctx.width,
      ctx.height,
      prevX,
      prevY,
      x,
      y,
      ctx.brushSize,
      pixelValueFor(ctx, TRANSPARENT),
      ctx.selection,
    );
  },
};
