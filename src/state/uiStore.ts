import { create } from 'zustand';

/** Two modes, not three — animation is a panel inside Edit (docs/10-decisions.md D6, D7). */
export type Mode = 'convert' | 'edit';

interface UIState {
  mode: Mode;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  /** Document-space cursor position, or null when off-canvas. */
  cursor: { x: number; y: number } | null;

  setMode(m: Mode): void;
  setZoom(z: number): void;
  zoomAt(factor: number, screenX: number, screenY: number): void;
  panBy(dx: number, dy: number): void;
  setPan(x: number, y: number): void;
  toggleGrid(): void;
  setCursor(c: { x: number; y: number } | null): void;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;

/** Grid appears automatically above this zoom (docs/05-ui-design.md §4). */
export const GRID_AUTO_ZOOM = 4;

export const useUIStore = create<UIState>((set) => ({
  mode: 'edit',
  zoom: 8,
  panX: 0,
  panY: 0,
  showGrid: true,
  cursor: null,

  setMode: (m) => set({ mode: m }),
  setZoom: (z) => set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) }),

  /**
   * Zoom toward a screen point, keeping the document point under the cursor
   * fixed (docs/05-ui-design.md §7.2).
   */
  zoomAt: (factor, screenX, screenY) =>
    set((s) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom * factor));
      if (next === s.zoom) return s;
      const ratio = next / s.zoom;
      return {
        zoom: next,
        panX: screenX - (screenX - s.panX) * ratio,
        panY: screenY - (screenY - s.panY) * ratio,
      };
    }),

  panBy: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),
  setPan: (x, y) => set({ panX: x, panY: y }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setCursor: (c) => set({ cursor: c }),
}));
