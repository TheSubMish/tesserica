/**
 * Mirror-axis drawing (`docs/03-data-model.md` §6.2).
 *
 * The axes run through the sprite's centre. A mirrored stroke is not post-processed:
 * each mirrored copy is the *same tool* driven with reflected coordinates and its
 * own stroke state, so pixel-perfect trimming and shape previews behave identically
 * in every copy.
 */

import type { ToolId } from '../state/toolStore';
import type { Tool, ToolContext } from './Tool';

/** Tools whose output is a drawing, and so makes sense to mirror. */
export const MIRRORABLE_TOOLS: ReadonlySet<ToolId> = new Set([
  'pencil',
  'eraser',
  'line',
  'rect',
  'ellipse',
]);

/** Of those, the ones that stamp a `brushSize` footprint (shapes are always 1px). */
const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set(['pencil', 'eraser', 'line']);

export interface Mirror {
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/** The identity first, then each reflection the enabled axes imply (1, 2 or 4 in all). */
export function mirrorsFor(x: boolean, y: boolean): Mirror[] {
  const out: Mirror[] = [{ flipX: false, flipY: false }];
  if (x) out.push({ flipX: true, flipY: false });
  if (y) out.push({ flipX: false, flipY: true });
  if (x && y) out.push({ flipX: true, flipY: true });
  return out;
}

/**
 * Reflect one coordinate across the axis of a `length`-pixel span.
 *
 * `brush` is the brush size when the point is the *centre of a stamped footprint*.
 * An even-sized brush is not centred on its pixel (it extends one further to the
 * right/bottom), so reflecting the centre alone would shift the mirrored footprint
 * by one pixel; this corrects for it.
 */
export function mirrorCoord(c: number, length: number, brush = 1): number {
  const evenCorrection = brush > 1 && brush % 2 === 0 ? 1 : 0;
  return length - 1 - c - evenCorrection;
}

export function mirrorPoint(
  m: Mirror,
  x: number,
  y: number,
  width: number,
  height: number,
  tool: ToolId,
  brushSize: number,
): { x: number; y: number } {
  const brush = BRUSH_TOOLS.has(tool) ? brushSize : 1;
  return {
    x: m.flipX ? mirrorCoord(x, width, brush) : x,
    y: m.flipY ? mirrorCoord(y, height, brush) : y,
  };
}

export type Phase = 'down' | 'move' | 'up';

/** Drive one tool callback for the given phase. */
export function runPhase(
  tool: Tool,
  phase: Phase,
  ctx: ToolContext,
  x: number,
  y: number,
  prevX: number,
  prevY: number,
): void {
  if (phase === 'down') tool.onPointerDown(ctx, x, y);
  else if (phase === 'move') tool.onPointerMove(ctx, x, y, prevX, prevY);
  else tool.onPointerUp?.(ctx, x, y);
}

/**
 * Replay a gesture, reflected, through the same tool — everything except the
 * original (identity) copy, which the caller has already run.
 *
 * Each copy has its own `strokeState` (kept in `states`, reset on `'down'`) and
 * anchor. Only the original may `restore()` the stroke snapshot — a shape preview
 * does so on every move, and a mirrored copy doing it too would wipe the others.
 */
export function replayMirrored(opts: {
  tool: Tool;
  phase: Phase;
  ctx: ToolContext;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  symmetryX: boolean;
  symmetryY: boolean;
  states: Record<string, unknown>[];
}): void {
  const { tool, phase, ctx, symmetryX, symmetryY, states } = opts;
  if (tool.readOnly || !MIRRORABLE_TOOLS.has(tool.id as ToolId)) return;
  const mirrors = mirrorsFor(symmetryX, symmetryY);
  for (let i = 1; i < mirrors.length; i++) {
    if (phase === 'down') states[i] = {};
    const at = (px: number, py: number) =>
      mirrorPoint(mirrors[i], px, py, ctx.width, ctx.height, tool.id as ToolId, ctx.brushSize);
    const p = at(opts.x, opts.y);
    const q = at(opts.prevX, opts.prevY);
    runPhase(
      tool,
      phase,
      {
        ...ctx,
        strokeState: (states[i] ??= {}),
        anchor: at(ctx.anchor.x, ctx.anchor.y),
        restore: () => {},
      },
      p.x,
      p.y,
      q.x,
      q.y,
    );
  }
}
