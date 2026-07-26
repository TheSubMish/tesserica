/**
 * Eyedropper.
 *
 * Samples the *composited* colour, which is what the user sees and points at —
 * sampling the active layer would return transparent whenever the visible
 * colour comes from a layer below.
 *
 * Marked `readOnly`, so the canvas neither snapshots the cel nor records an
 * undo step for it: picking a colour is not an edit to the document.
 */

import type { Tool } from './Tool';

export const picker: Tool = {
  id: 'eyedropper',
  label: 'Eyedropper',
  readOnly: true,

  onPointerDown(ctx, x, y) {
    const c = ctx.sample(x, y);
    if (!c) return;
    ctx.setColor(c, ctx.button === 2 ? 'secondary' : 'primary');
  },

  // Dragging keeps picking, so you can scrub for the colour you want.
  onPointerMove(ctx, x, y) {
    const c = ctx.sample(x, y);
    if (!c) return;
    ctx.setColor(c, ctx.button === 2 ? 'secondary' : 'primary');
  },
};
