/**
 * Palettes available in the session: the bundled hardware sets plus anything
 * the user has imported (`docs/03-data-model.md` §3).
 *
 * D9 — v1 is RGBA only, so a palette is purely a swatch list. Nothing indexes
 * into it, choosing a colour outside it is legal, and there is no policy to
 * decide about off-palette colours. Indexed mode is Phase 7.
 */

import { create } from 'zustand';
import type { Palette, RGBA } from '../model/types';
import { BUILTIN_PALETTES } from '../lib/palettes/builtin';

/**
 * The one hand-picked palette every session gets for free, filled in one
 * colour at a time from the panel's colour picker. Exists so "I want a
 * colour that isn't in any bundled or imported palette" has an answer that
 * doesn't require bundling a new asset — see `docs/08-roadmap.md` Phase 8's
 * palette item and `Palette.source.kind === 'custom'`, reserved for exactly
 * this and previously unused.
 */
const CUSTOM_PALETTE_ID = 'custom';

function emptyCustomPalette(): Palette {
  return { id: CUSTOM_PALETTE_ID, name: 'Custom', colors: [], source: { kind: 'custom' } };
}

interface PaletteState {
  palettes: Palette[];
  activePaletteId: string;

  setActivePalette(id: string): void;
  /** Add an imported palette and select it. Returns the id actually used. */
  addPalette(palette: Palette): string;
  activePalette(): Palette;
  /**
   * Append a colour to the session's Custom palette, creating it on first
   * use, and switch to it so the new swatch is immediately visible. A
   * duplicate of a colour already in Custom is a no-op rather than a second
   * identical swatch.
   */
  addCustomColor(color: RGBA): void;
  /** Remove one swatch from the Custom palette by index. */
  removeCustomColor(index: number): void;
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

  addCustomColor: (color) =>
    set((s) => {
      const existing = s.palettes.find((p) => p.id === CUSTOM_PALETTE_ID);
      const base = existing ?? emptyCustomPalette();
      if (
        base.colors.some(
          (c) => c[0] === color[0] && c[1] === color[1] && c[2] === color[2] && c[3] === color[3],
        )
      ) {
        return { activePaletteId: CUSTOM_PALETTE_ID };
      }
      const updated = { ...base, colors: [...base.colors, color] };
      const palettes = existing
        ? s.palettes.map((p) => (p.id === CUSTOM_PALETTE_ID ? updated : p))
        : [...s.palettes, updated];
      return { palettes, activePaletteId: CUSTOM_PALETTE_ID };
    }),

  removeCustomColor: (index) =>
    set((s) => {
      const custom = s.palettes.find((p) => p.id === CUSTOM_PALETTE_ID);
      if (!custom) return s;
      const colors = custom.colors.filter((_, i) => i !== index);
      return {
        palettes: s.palettes.map((p) => (p.id === CUSTOM_PALETTE_ID ? { ...p, colors } : p)),
      };
    }),
}));
