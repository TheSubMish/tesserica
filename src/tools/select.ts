/**
 * Select (`docs/08-roadmap.md` Phase 3 — "selection tools + move";
 * `docs/05-ui-design.md` §4.1 lists `M` for "Select: Rect, ellipse, lasso,
 * magic wand" — one tool with a shape choice, the same pattern as Fill's
 * contiguous/global option, not four separate tools).
 *
 * - **Rect** / **ellipse** drag out from the anchor, live-previewing on every
 *   pointer move, same as the Rectangle/Ellipse draw tools.
 * - **Lasso** accumulates the freehand path in `strokeState` and rasterizes it
 *   into a mask on release (`model/polygon.ts`).
 * - **Wand** has no drag: it samples the seed pixel on pointer-down and
 *   selects its 4-connected region immediately (`fill.ts#wandSelection`).
 *
 * `readOnly`: none of the four ever touch the cel, so the canvas takes no
 * snapshot and the gesture makes no undo step — consistent with the
 * eyedropper (`picker.ts`).
 */

import type { Rect } from '../model/rect';
import { rectSelection, type Selection } from '../model/selection';
import { polygonSelection, type Point } from '../model/polygon';
import { wandSelection } from './fill';
import { ellipseSelection } from './shapes';
import type { Tool, ToolContext } from './Tool';

/** Two dragged corners, inclusive, → a `Rect` in the `{x,y,width,height}` shape. */
export function dragToRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function dragSelection(ctx: ToolContext, x0: number, y0: number, x1: number, y1: number): void {
  const s: Selection | null =
    ctx.selectMode === 'ellipse'
      ? ellipseSelection(x0, y0, x1, y1)
      : rectSelection(dragToRect(x0, y0, x1, y1));
  ctx.setSelection(s);
}

export const select: Tool = {
  id: 'select',
  label: 'Select',
  readOnly: true,

  onPointerDown(ctx, x, y) {
    if (ctx.selectMode === 'lasso') {
      ctx.strokeState.points = [{ x, y }] as Point[];
      return;
    }
    if (ctx.selectMode === 'wand') {
      const bpp = ctx.colorMode === 'indexed' ? 1 : 4;
      ctx.setSelection(wandSelection(ctx.buffer, ctx.width, ctx.height, x, y, bpp));
      return;
    }
    dragSelection(ctx, x, y, x, y);
  },

  onPointerMove(ctx, x, y) {
    if (ctx.selectMode === 'wand') return; // a click, not a drag
    if (ctx.selectMode === 'lasso') {
      const points = ctx.strokeState.points as Point[] | undefined;
      if (!points) return;
      const last = points[points.length - 1];
      if (last.x !== x || last.y !== y) points.push({ x, y });
      // Live-preview the same way rect/ellipse do, once there is enough of a
      // path to rasterize into a polygon.
      if (points.length >= 3) ctx.setSelection(polygonSelection(points));
      return;
    }
    dragSelection(ctx, ctx.anchor.x, ctx.anchor.y, x, y);
  },

  onPointerUp(ctx, x, y) {
    if (ctx.selectMode === 'wand') return; // finalized on pointer-down

    if (ctx.selectMode === 'lasso') {
      const points = ctx.strokeState.points as Point[] | undefined;
      // A click with no drag deselects, same as rect/ellipse below.
      if (!points || points.length < 3) {
        ctx.setSelection(null);
        return;
      }
      ctx.setSelection(polygonSelection(points));
      return;
    }

    // A click with no drag deselects, matching every reference editor —
    // otherwise there is no gesture that clears a selection except making a
    // new one.
    if (x === ctx.anchor.x && y === ctx.anchor.y) ctx.setSelection(null);
  },
};
