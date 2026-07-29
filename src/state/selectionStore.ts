/**
 * The active selection (`docs/08-roadmap.md` Phase 3 — "selection tools +
 * move").
 *
 * Document-space, not layer-space: a selection outlives whichever layer was
 * active when it was drawn, the same way it does in every reference editor —
 * switching layers to paint the same region on a different one is the whole
 * point.
 *
 * Holds a `Selection` (`model/selection.ts` — a bounding rect plus an
 * optional mask), not a plain `Rect`: rectangular marquee, ellipse, lasso and
 * magic wand all produce a `Selection`, differing only in whether a mask is
 * present. Kept separate from `documentStore` because a selection is not part
 * of the document — it does not save into `.tess` and does not participate in
 * undo.
 */

import { create } from 'zustand';
import type { Selection } from '../model/selection';

interface SelectionState {
  selection: Selection | null;
  setSelection(s: Selection | null): void;
  clear(): void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selection: null,
  setSelection: (s) => set({ selection: s }),
  clear: () => set({ selection: null }),
}));
