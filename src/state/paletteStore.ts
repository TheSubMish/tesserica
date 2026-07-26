/**
 * Palettes available in the session: the bundled hardware sets plus anything
 * the user has imported (`docs/03-data-model.md` §3).
 *
 * D9 — v1 is RGBA only, so a palette is purely a swatch list. Nothing indexes
 * into it, choosing a colour outside it is legal, and there is no policy to
 * decide about off-palette colours. Indexed mode is Phase 7.
 */

import { create } from 'zustand';
import type { Palette } from '../model/types';
import { BUILTIN_PALETTES } from '../lib/palettes/builtin';

interface PaletteState {
  palettes: Palette[];
  activePaletteId: string;

  setActivePalette(id: string): void;
  /** Add an imported palette and select it. Returns the id actually used. */
  addPalette(palette: Palette): string;
  activePalette(): Palette;
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  palettes: BUILTIN_PALETTES,
  activePaletteId: BUILTIN_PALETTES[0].id,

  setActivePalette: (id) =>
    set((s) => (s.palettes.some((p) => p.id === id) ? { activePaletteId: id } : s)),

  addPalette: (palette) => {
    // Importing the same file twice should not shadow the first copy with an
    // id collision; suffix instead.
    let id = palette.id;
    let n = 2;
    while (get().palettes.some((p) => p.id === id)) id = `${palette.id}-${n++}`;
    const stored = { ...palette, id };
    set((s) => ({ palettes: [...s.palettes, stored], activePaletteId: id }));
    return id;
  },

  activePalette: () => {
    const s = get();
    return s.palettes.find((p) => p.id === s.activePaletteId) ?? s.palettes[0];
  },
}));
