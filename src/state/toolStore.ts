import { create } from 'zustand';
import type { RGBA } from '../model/types';

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'eyedropper'
  | 'select'
  | 'move'
  | 'zoom';

/**
 * Sub-mode of the Select tool (`docs/05-ui-design.md` §4.1 — "Select: Rect,
 * ellipse, lasso, magic wand" is one tool with a shape choice, the same
 * pattern as Fill's contiguous/global option, not four separate tools).
 */
export type SelectMode = 'rect' | 'ellipse' | 'lasso' | 'wand';

interface ToolState {
  activeTool: ToolId;
  /** Foreground / background colors — `X` swaps, per docs/05-ui-design.md §7. */
  primary: RGBA;
  secondary: RGBA;
  brushSize: number;
  /** Removes L-corner doubling from freehand diagonals. On by default (§4.1). */
  pixelPerfect: boolean;
  /** Rect/ellipse draw filled rather than outlined. */
  shapeFill: boolean;
  /** Fill stops at the contiguous region rather than recolouring the whole cel. */
  fillContiguous: boolean;
  /** Which shape the Select tool draws. */
  selectMode: SelectMode;

  setTool(id: ToolId): void;
  setPrimary(c: RGBA): void;
  setSecondary(c: RGBA): void;
  swapColors(): void;
  /** `D` resets to black/white (docs/05-ui-design.md §7.5). */
  resetColors(): void;
  setBrushSize(n: number): void;
  setPixelPerfect(v: boolean): void;
  setShapeFill(v: boolean): void;
  setFillContiguous(v: boolean): void;
  setSelectMode(m: SelectMode): void;
}

export const DEFAULT_PRIMARY: RGBA = [0, 0, 0, 255];
export const DEFAULT_SECONDARY: RGBA = [255, 255, 255, 255];

export const useToolStore = create<ToolState>((set) => ({
  activeTool: 'pencil',
  // Starts on the light of the pair, since a fresh document is transparent over
  // a dark checkerboard and a black stroke would be nearly invisible.
  primary: DEFAULT_SECONDARY,
  secondary: DEFAULT_PRIMARY,
  brushSize: 1,
  pixelPerfect: true,
  shapeFill: false,
  fillContiguous: true,
  selectMode: 'rect',

  setTool: (id) => set({ activeTool: id }),
  setPrimary: (c) => set({ primary: c }),
  setSecondary: (c) => set({ secondary: c }),
  swapColors: () => set((s) => ({ primary: s.secondary, secondary: s.primary })),
  resetColors: () => set({ primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY }),
  setBrushSize: (n) => set({ brushSize: Math.max(1, Math.min(32, n)) }),
  setPixelPerfect: (v) => set({ pixelPerfect: v }),
  setShapeFill: (v) => set({ shapeFill: v }),
  setFillContiguous: (v) => set({ fillContiguous: v }),
  setSelectMode: (m) => set({ selectMode: m }),
}));
