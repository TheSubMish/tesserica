/**
 * Turns one pointer gesture into one undo step (`docs/03-data-model.md` §6:
 * "One drag = one undo step, not 200").
 *
 * `begin` copies the cel once. The tool then draws freely — no per-event
 * bookkeeping, no tracker threaded through `setPixel`. `finish` diffs the
 * snapshot against the buffer, which yields the exact dirty rect for *any*
 * tool, flood fill included, and the transient full-cel copy is dropped.
 *
 * The snapshot doubles as the shape-preview mechanism: line/rect/ellipse
 * restore it before redrawing at the new cursor position, so the live preview
 * is the real pixels rather than an approximation drawn in an overlay.
 */

import type { CelId } from '../model/types';
import { PixelDeltaCommand } from './commands';
import { makePixelDelta } from './pixelDelta';

type CelBuffer = Uint8ClampedArray | Uint8Array;

export interface StrokeSnapshot {
  celId: CelId;
  width: number;
  height: number;
  /** The cel exactly as it was at pointer-down. */
  pixels: CelBuffer;
  /** `docs/08-roadmap.md` Phase 7 — 4 for RGBA, 1 for an indexed cel's palette index. */
  bytesPerPixel: number;
}

export function beginStroke(
  celId: CelId,
  buffer: CelBuffer,
  width: number,
  height: number,
  bytesPerPixel = 4,
): StrokeSnapshot {
  return { celId, width, height, pixels: buffer.slice(), bytesPerPixel };
}

/** Put the cel back to its pointer-down state — used between shape previews. */
export function restoreStroke(snapshot: StrokeSnapshot, buffer: CelBuffer): void {
  buffer.set(snapshot.pixels);
}

/**
 * Build the undo step for a finished gesture, or `null` when the gesture
 * changed nothing (a click that repainted an identical pixel, a shape dragged
 * back to zero size).
 */
export function finishStroke(
  snapshot: StrokeSnapshot,
  buffer: CelBuffer,
  label: string,
): PixelDeltaCommand | null {
  const delta = makePixelDelta(
    snapshot.celId,
    snapshot.pixels,
    buffer,
    snapshot.width,
    snapshot.height,
    snapshot.bytesPerPixel,
  );
  if (!delta) return null;
  return new PixelDeltaCommand(label, delta, snapshot.width);
}
