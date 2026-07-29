import { create } from 'zustand';

/** Two modes, not three — animation is a panel inside Edit (docs/10-decisions.md D6, D7). */
export type Mode = 'convert' | 'edit';

interface UIState {
  mode: Mode;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  /**
   * Timeline panel visibility (`docs/05-ui-design.md` §5, `docs/10-decisions.md`
   * D7) — hidden by default so people making single sprites never see it,
   * toggled from the title bar's Timeline button or the `T` shortcut.
   */
  showTimeline: boolean;
  /**
   * Onion skinning (`docs/08-roadmap.md` Phase 4, `docs/05-ui-design.md` §5) —
   * view-only, so it lives alongside `showGrid` rather than in the document:
   * it never affects a cel buffer or an export. Toggled and range-configured
   * from the Timeline panel; off by default so a single-frame sprite never
   * shows a ghost of itself. Range is frame counts, not pixels — `before`/
   * `after` are independent so a walk cycle can weight one direction over
   * the other.
   */
  onionSkinEnabled: boolean;
  onionSkinBefore: number;
  onionSkinAfter: number;
  /** Document-space cursor position, or null when off-canvas. */
  cursor: { x: number; y: number } | null;
  /**
   * Bumped whenever the viewport should re-fit and re-center the sprite —
   * `Ctrl+N` (`docs/06-workflows.md` W2 step 2) and `Home`/the status bar's
   * "center view" button. `CanvasView` watches this rather than sprite size
   * directly, because a new document can share the previous one's dimensions
   * and still needs its pan reset, and because "center the view" has to work
   * even when nothing about the sprite itself has changed.
   */
  fitRequest: number;

  setMode(m: Mode): void;
  setZoom(z: number): void;
  zoomAt(factor: number, screenX: number, screenY: number): void;
  panBy(dx: number, dy: number): void;
  setPan(x: number, y: number): void;
  toggleGrid(): void;
  toggleTimeline(): void;
  toggleOnionSkin(): void;
  setOnionSkinBefore(n: number): void;
  setOnionSkinAfter(n: number): void;
  setCursor(c: { x: number; y: number } | null): void;
  /**
   * Re-fit and re-center the canvas on the sprite — "move the view back to
   * the center of the picture" after panning away, at whatever integer zoom
   * fits the current viewport (`canvas/coords.ts::fitZoom`).
   */
  requestFit(): void;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;

/** Grid appears automatically above this zoom (docs/05-ui-design.md §4). */
export const GRID_AUTO_ZOOM = 4;

/** A range past this is more clutter than reference — same order of magnitude as Aseprite's own default ceiling. */
export const MAX_ONION_SKIN_RANGE = 8;

const clampOnionSkinRange = (n: number): number =>
  Math.max(0, Math.min(MAX_ONION_SKIN_RANGE, Math.round(n)));

export const useUIStore = create<UIState>((set) => ({
  mode: 'edit',
  zoom: 8,
  panX: 0,
  panY: 0,
  showGrid: true,
  showTimeline: false,
  onionSkinEnabled: false,
  onionSkinBefore: 1,
  onionSkinAfter: 1,
  cursor: null,
  fitRequest: 0,

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
  toggleTimeline: () => set((s) => ({ showTimeline: !s.showTimeline })),
  toggleOnionSkin: () => set((s) => ({ onionSkinEnabled: !s.onionSkinEnabled })),
  setOnionSkinBefore: (n) => set({ onionSkinBefore: clampOnionSkinRange(n) }),
  setOnionSkinAfter: (n) => set({ onionSkinAfter: clampOnionSkinRange(n) }),
  setCursor: (c) => set({ cursor: c }),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
}));
