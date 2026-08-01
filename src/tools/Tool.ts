/**
 * Tool interface.
 *
 * `docs/02-architecture.md` §4 has tools producing Commands for the undo
 * system. In practice the command is produced *around* the tool: the canvas
 * snapshots the cel at pointer-down and diffs at pointer-up
 * (`history/strokeRecorder.ts`), so a tool only has to mutate pixels and the
 * dirty rect falls out exactly. That keeps every tool free of undo
 * bookkeeping.
 *
 * Two capabilities the context provides are what make the harder tools simple:
 *
 * - `restore()` puts the cel back to its pointer-down state, so line/rect/
 *   ellipse preview by *actually drawing* the shape each time the pointer
 *   moves rather than approximating it in an overlay. What you drag is what
 *   you get.
 * - `restorePixel()` undoes a single pixel, which is how pixel-perfect mode
 *   retracts an L-corner it has just drawn.
 */

import type { Selection } from '../model/selection';
import type { ColorMode, Palette, RGBA } from '../model/types';
import type { SelectMode } from '../state/toolStore';

export interface ToolContext {
  /**
   * The active cel's own raw storage — a `Uint8ClampedArray` of RGBA bytes
   * for an `'rgba'`-mode sprite, or a `Uint8Array` of one palette index per
   * pixel for an `'indexed'`-mode one (`docs/08-roadmap.md` Phase 7,
   * `model/celStorage.ts`). Tools that paint should go through
   * `tools/pixelValue.ts::pixelValueFor` to get the right shape of value to
   * write rather than assuming RGBA.
   */
  buffer: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** `docs/08-roadmap.md` Phase 7 — which storage `buffer` actually is. */
  colorMode: ColorMode;
  /** Only meaningful when `colorMode === 'indexed'` — the sprite's own assigned palette. */
  palette: Palette | undefined;
  primary: RGBA;
  secondary: RGBA;
  brushSize: number;
  /** Which mouse button — right-drag paints with the secondary color. */
  button: number;

  /** Remove doubled corner pixels from freehand diagonals. */
  pixelPerfect: boolean;
  /** Shapes are filled rather than outlined. */
  shapeFill: boolean;
  /** Flood fill stops at the contiguous region rather than the whole cel. */
  fillContiguous: boolean;
  /** Which selection shape the Select tool draws (`docs/08-roadmap.md` Phase 3). */
  selectMode: SelectMode;

  /** Where the gesture started, in cel-local pixels. */
  anchor: { x: number; y: number };
  /** Per-gesture scratch space; the canvas clears it at pointer-down. */
  strokeState: Record<string, unknown>;

  /**
   * The active selection, or `null` when nothing is selected
   * (`docs/08-roadmap.md` Phase 3, "selection tools + move"). Painting tools
   * clip to this; the Move tool translates its contents.
   *
   * A bounding `Rect` plus an optional mask (`model/selection.ts`) — the mask
   * is what lets ellipse, lasso and magic-wand selections exist without every
   * consumer needing a separate code path from the plain rectangular marquee.
   */
  selection: Selection | null;
  /** Replace the selection, or pass `null` to clear it. */
  setSelection(s: Selection | null): void;

  /** Restore the whole cel to its pointer-down state. */
  restore(): void;
  /** Restore one pixel to its pointer-down value. */
  restorePixel(x: number, y: number): void;

  /** Composited color at a document pixel, or null when out of bounds. */
  sample(x: number, y: number): RGBA | null;
  /** Assign the picked color to the primary or secondary slot. */
  setColor(c: RGBA, slot: 'primary' | 'secondary'): void;
}

export interface Tool {
  id: string;
  /** Shown as the undo step name, e.g. "Pencil". */
  label: string;
  /**
   * True for tools that never write pixels. The canvas skips snapshotting the
   * cel for these, so picking a color costs nothing and makes no undo step.
   */
  readOnly?: boolean;
  onPointerDown(ctx: ToolContext, x: number, y: number): void;
  onPointerMove(ctx: ToolContext, x: number, y: number, prevX: number, prevY: number): void;
  onPointerUp?(ctx: ToolContext, x: number, y: number): void;
}
