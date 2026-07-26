/**
 * Tool interface.
 *
 * `docs/02-architecture.md` §4 has tools returning Commands for the undo
 * system. That system arrives in Phase 1 (`docs/03-data-model.md` §6); Phase 0
 * tools mutate the active cel directly. The signature is shaped so that
 * returning a Command later is an addition, not a rewrite.
 */

import type { RGBA } from '../model/types';

export interface ToolContext {
  /** Pixel buffer of the active cel. */
  buffer: Uint8ClampedArray;
  width: number;
  height: number;
  primary: RGBA;
  secondary: RGBA;
  brushSize: number;
  /** Which mouse button — right-drag paints with the secondary color. */
  button: number;
}

export interface Tool {
  id: string;
  onPointerDown(ctx: ToolContext, x: number, y: number): void;
  onPointerMove(ctx: ToolContext, x: number, y: number, prevX: number, prevY: number): void;
  onPointerUp?(ctx: ToolContext): void;
}
