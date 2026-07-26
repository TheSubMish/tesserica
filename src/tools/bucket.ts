/** Paint bucket. Geometry lives in `fill.ts`. */

import type { Tool } from './Tool';
import { fillContiguous, fillGlobal } from './fill';
import { colorFor } from './pencil';

export const bucket: Tool = {
  id: 'fill',
  label: 'Fill',
  onPointerDown(ctx, x, y) {
    const color = colorFor(ctx);
    if (ctx.fillContiguous) fillContiguous(ctx.buffer, ctx.width, ctx.height, x, y, color);
    else fillGlobal(ctx.buffer, ctx.width, ctx.height, x, y, color);
  },
  // A fill is a click, not a drag. Dragging after the click would re-seed on
  // every pointer move and flood the whole cel a run at a time.
  onPointerMove() {},
};
