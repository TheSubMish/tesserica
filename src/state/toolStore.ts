import { create } from 'zustand';
import type { RGBA } from '../model/types';

export type ToolId = 'pencil' | 'eraser';

interface ToolState {
  activeTool: ToolId;
  /** Foreground / background colors — `X` swaps, per docs/05-ui-design.md §7. */
  primary: RGBA;
  secondary: RGBA;
  brushSize: number;

  setTool(id: ToolId): void;
  setPrimary(c: RGBA): void;
  swapColors(): void;
  /** `D` resets to black/white (docs/05-ui-design.md §7.5). */
  resetColors(): void;
  setBrushSize(n: number): void;
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

  setTool: (id) => set({ activeTool: id }),
  setPrimary: (c) => set({ primary: c }),
  swapColors: () => set((s) => ({ primary: s.secondary, secondary: s.primary })),
  resetColors: () => set({ primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY }),
  setBrushSize: (n) => set({ brushSize: Math.max(1, Math.min(32, n)) }),
}));
