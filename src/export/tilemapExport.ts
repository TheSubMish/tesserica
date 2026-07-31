/**
 * Selection + concatenation for tileset/tilemap JSON export
 * (`docs/08-roadmap.md` Phase 6 "Tileset + tilemap JSON export").
 *
 * Kept pure and independent of the IPC/dialog layer, the same split
 * `export/animationExport.ts` uses: "which tilemap layer, which tileset,
 * which grid cells" and "how its tiles' pixels get concatenated into one
 * staged buffer" are both testable without a backend or a Tauri shell.
 *
 * Unlike `flattenSprite`, nothing here is resolution-dependent — a tile's own
 * `Uint8ClampedArray` (`model/tileBuffers.ts`) already *is* the full-
 * resolution pixel data Rust will atlas and encode, so there is no
 * proxy/downscale concern to reason about (`docs/02-architecture.md`'s
 * "Rust produces what you ship" still holds: Rust does the atlasing, the
 * scaling and the PNG/JSON encode; this module only picks which bytes to
 * stage).
 */

import { celBufferId } from '../model/types';
import type { Layer, Sprite, Tileset } from '../model/types';
import { getGrid } from '../model/tileGridBuffers';
import { getTileBuffer } from '../model/tileBuffers';
import { tileGridDims } from '../model/tileIds';

export type TilemapLayer = Extract<Layer, { kind: 'tilemap' }>;

export interface TilemapExportSelection {
  layer: TilemapLayer;
  tileset: Tileset;
  cols: number;
  rows: number;
  /** Packed Tesserica tile ids (`model/tileIds.ts`), row-major, `cols * rows` entries. */
  tileIds: number[];
}

/**
 * Resolve everything a tileset/tilemap export needs from one tilemap layer at
 * one frame: its tileset, its grid dimensions, and the grid's own packed tile
 * ids. `undefined` when the layer isn't a tilemap layer, its tileset is
 * missing, it has no cel at this frame, or the grid has no cells at all (e.g.
 * a cel smaller than one tile) — every case this module itself cannot turn
 * into a meaningful export.
 */
export function tilemapExportSelection(
  sprite: Sprite,
  layerId: string,
  frameId: string,
): TilemapExportSelection | undefined {
  const layer = sprite.layers.find((l) => l.id === layerId);
  if (!layer || layer.kind !== 'tilemap') return undefined;

  const tileset = sprite.tilesets.find((t) => t.id === layer.tilesetId);
  if (!tileset) return undefined;

  const cel = sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId);
  if (!cel) return undefined;

  const grid = getGrid(celBufferId(cel));
  if (!grid) return undefined;

  const { cols, rows } = tileGridDims(cel, layer.grid);
  if (cols === 0 || rows === 0) return undefined;

  const tileIds = Array.from(grid.subarray(0, cols * rows));
  return { layer, tileset, cols, rows, tileIds };
}

export interface TileAtlasPixels {
  pixels: Uint8ClampedArray;
  /** Number of *real* tiles included — the tileset's own tile count minus 1. */
  count: number;
}

/**
 * Concatenate every real tile's own pixels — Tesserica index 1.. in
 * ascending order — into one buffer, skipping index 0 (the mandatory empty
 * tile, `docs/03-data-model.md` §4). Tiled's own GID 0 already means "no
 * tile here", so the exported atlas never needs a blank slot for it
 * (`src-tauri/src/commands/tilemap_export.rs`'s own doc comment has the full
 * reasoning for why this lines up exactly with `firstgid = 1`).
 *
 * `undefined` when any real tile is missing its own pixel buffer — this
 * should never happen in a consistent document, but every existing pixel
 * buffer lookup elsewhere in this codebase treats a miss as "cannot proceed"
 * rather than silently exporting garbage.
 */
export function concatTilePixels(tileset: Tileset): TileAtlasPixels | undefined {
  const perTile = tileset.tileWidth * tileset.tileHeight * 4;
  const realTiles = tileset.tiles.slice(1);
  const out = new Uint8ClampedArray(perTile * realTiles.length);
  for (let i = 0; i < realTiles.length; i++) {
    const buf = getTileBuffer(realTiles[i].id);
    if (!buf) return undefined;
    out.set(buf, i * perTile);
  }
  return { pixels: out, count: realTiles.length };
}

/**
 * Starting column count for the assembled tileset sheet — mirrors
 * `export/animationExport.ts::DEFAULT_SPRITESHEET_COLUMNS`'s role, clamped
 * server-side (`src-tauri/src/commands/animation_export.rs::SheetLayout`) the
 * same way a spritesheet's own column count is.
 */
export const DEFAULT_TILESET_SHEET_COLUMNS = 8;
