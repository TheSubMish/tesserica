/**
 * The active rectangular selection (`docs/08-roadmap.md` Phase 3 — "selection
 * tools + move").
 *
 * Document-space, not layer-space: a selection outlives whichever layer was
 * active when it was drawn, the same way it does in every reference editor —
 * switching layers to paint the same region on a different one is the whole
 * point.
 *
 * v1 ships **rectangular marquee only**. Ellipse, lasso and magic wand are
 * roadmap items this pass did not reach; the store's shape (a single `Rect`,
 * not a mask) would need to change to add them; kept separate from
 * `documentStore` because a selection is not part of the document — it does
 * not save into `.tess` and does not participate in undo.
 */

import { create } from 'zustand';
import type { Rect } from '../model/rect';

interface SelectionState {
  rect: Rect | null;
  setRect(r: Rect | null): void;
  clear(): void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  rect: null,
  setRect: (r) => set({ rect: r }),
  clear: () => set({ rect: null }),
}));
