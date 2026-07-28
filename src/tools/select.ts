/**
 * Rectangular marquee select (`docs/08-roadmap.md` Phase 3 — "selection tools
 * ... + move"; `docs/05-ui-design.md` §4.1 lists `M` for "Select").
 *
 * v1 ships **rectangle only**. Ellipse, lasso and magic wand are not
 * implemented — the selection model is a single `Rect`
 * (`state/selectionStore.ts`), not a general mask, so those would need a
 * different representation, not just a different tool.
 *
 * `readOnly`: dragging a marquee never touches the cel, so the canvas takes no
 * snapshot and the gesture makes no undo step — consistent with the
 * eyedropper (`picker.ts`).
 */

import type { Rect } from '../model/rect';
import type { Tool } from './Tool';

/** Two dragged corners, inclusive, → a `Rect` in the `{x,y,width,height}` shape. */
export function dragToRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export const select: Tool = {
  id: 'select',
  label: 'Select',
  readOnly: true,

  onPointerDown(ctx, x, y) {
    ctx.setSelection(dragToRect(x, y, x, y));
  },

  onPointerMove(ctx, x, y) {
    ctx.setSelection(dragToRect(ctx.anchor.x, ctx.anchor.y, x, y));
  },

  onPointerUp(ctx, x, y) {
    // A click with no drag deselects, matching every reference editor —
    // otherwise there is no gesture that clears a selection except making a
    // new one.
    if (x === ctx.anchor.x && y === ctx.anchor.y) ctx.setSelection(null);
  },
};
