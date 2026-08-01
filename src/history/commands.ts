/** Concrete commands. Pixel edits live here. */

import { getBufferForBpp } from '../model/celStorage';
import type { Command, DocumentApi } from './command';
import { blitRegion, deltaMemoryCost, mergePixelDeltas, type PixelDelta } from './pixelDelta';

/**
 * A drawing edit, stored as before/after bytes for one dirty rect.
 *
 * `coalesceKey` opts into merging: two pixel commands merge only when both
 * carry the same non-null key, so consecutive *separate* pencil clicks stay
 * separate undo steps while a gesture that emits several commands (a shape
 * being dragged, a slider driving a filter) collapses into one.
 */
export class PixelDeltaCommand implements Command {
  readonly memoryCost: number;

  constructor(
    public readonly label: string,
    public readonly delta: PixelDelta,
    /** Width of the cel buffer the delta indexes into. */
    public readonly celWidth: number,
    public readonly coalesceKey: string | null = null,
  ) {
    this.memoryCost = deltaMemoryCost(delta);
  }

  apply(doc: DocumentApi): void {
    const buf = getBufferForBpp(this.delta.celId, this.delta.bytesPerPixel);
    if (!buf) return;
    blitRegion(buf, this.celWidth, this.delta.rect, this.delta.after, this.delta.bytesPerPixel);
    doc.touch(this.delta.celId);
  }

  invert(doc: DocumentApi): void {
    const buf = getBufferForBpp(this.delta.celId, this.delta.bytesPerPixel);
    if (!buf) return;
    blitRegion(buf, this.celWidth, this.delta.rect, this.delta.before, this.delta.bytesPerPixel);
    doc.touch(this.delta.celId);
  }

  coalesceWith(next: Command): Command | null {
    if (!(next instanceof PixelDeltaCommand)) return null;
    if (this.coalesceKey === null || this.coalesceKey !== next.coalesceKey) return null;
    if (this.delta.celId !== next.delta.celId) return null;

    const buf = getBufferForBpp(this.delta.celId, this.delta.bytesPerPixel);
    if (!buf) return null;

    return new PixelDeltaCommand(
      this.label,
      mergePixelDeltas(this.delta, next.delta, buf, this.celWidth),
      this.celWidth,
      this.coalesceKey,
    );
  }
}
