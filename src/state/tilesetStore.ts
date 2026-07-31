/**
 * Tile-picker UI state for the tile stamp tool (`docs/08-roadmap.md` Phase 6
 * "Tile stamp tool, auto-deduplication, flip/rotate flags").
 *
 * Which tileset/tile is picked, and the flip/rotate flags the stamp tool
 * applies before placing it, are view state — not document content — the
 * same reasoning `state/toolStore.ts`'s `selectMode` and `state/uiStore.ts`'s
 * onion-skin range already follow: none of this saves into `.tess` or
 * participates in undo. Kept in its own store rather than folded into
 * `toolStore` because it is scoped to one tool (Stamp) and one panel
 * (`panels/TilesetPanel.tsx`), the same way `state/selectionStore.ts` is its
 * own store rather than living in `documentStore`.
 */

import { create } from 'zustand';
import type { TilesetId } from '../model/types';

interface TilesetToolState {
  /** Which tileset the picker is showing/adding tiles to. */
  selectedTilesetId: TilesetId | null;
  /** Index into that tileset's `tiles` array, or `null` when nothing is picked. */
  selectedTileIndex: number | null;
  flipH: boolean;
  flipV: boolean;
  transpose: boolean;

  setSelectedTileset(id: TilesetId | null): void;
  /** Pick one tile from a tileset — clears any picked tile from a different one. */
  selectTile(tilesetId: TilesetId, index: number): void;
  setFlipH(v: boolean): void;
  setFlipV(v: boolean): void;
  setTranspose(v: boolean): void;
  toggleFlipH(): void;
  toggleFlipV(): void;
  toggleTranspose(): void;
}

export const useTilesetStore = create<TilesetToolState>((set) => ({
  selectedTilesetId: null,
  selectedTileIndex: null,
  flipH: false,
  flipV: false,
  transpose: false,

  setSelectedTileset: (id) =>
    set((s) => ({
      selectedTilesetId: id,
      // A tile index only means something within the tileset it was picked
      // from — switching tilesets drops it rather than silently reinterpreting
      // the same number against a different tile list.
      selectedTileIndex: id === s.selectedTilesetId ? s.selectedTileIndex : null,
    })),
  selectTile: (tilesetId, index) => set({ selectedTilesetId: tilesetId, selectedTileIndex: index }),
  setFlipH: (v) => set({ flipH: v }),
  setFlipV: (v) => set({ flipV: v }),
  setTranspose: (v) => set({ transpose: v }),
  toggleFlipH: () => set((s) => ({ flipH: !s.flipH })),
  toggleFlipV: () => set((s) => ({ flipV: !s.flipV })),
  toggleTranspose: () => set((s) => ({ transpose: !s.transpose })),
}));
