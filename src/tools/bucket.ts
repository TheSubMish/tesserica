/** Paint bucket. Geometry lives in `fill.ts`. */

import type { Tool } from './Tool';
import { fillContiguous, fillGlobal } from './fill';
import { colorFor } from './pencil';
import { pixelValueFor } from './pixelValue';

export const bucket: Tool = {
  id: 'fill',
  label: 'Fill',
  onPointerDown(ctx, x, y) {
    const value = pixelValueFor(ctx, colorFor(ctx));
    if (ctx.fillContiguous) {
      fillContiguous(ctx.buffer, ctx.width, ctx.height, x, y, value, ctx.selection);
    } else {
      fillGlobal(ctx.buffer, ctx.width, ctx.height, x, y, value, ctx.selection);
    }
  },
  // A fill is a click, not a drag. Dragging after the click would re-seed on
  // every pointer move and flood the whole cel a run at a time.
  onPointerMove() {},
};
