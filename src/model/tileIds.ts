/**
 * Tile-ID bit packing (`docs/03-data-model.md` §4).
 *
 * A tilemap cel's grid is a flat array of packed 32-bit ids — one per grid
 * cell — with the tile index in the low bits and flip/rotate flags in the
 * high bits, the same convention Godot and Tiled both use:
 *
 * ```
 * bits  0–27 : tile index
 * bit     28 : flip horizontal
 * bit     29 : flip vertical
 * bit     30 : transpose (diagonal flip)
 * ```
 *
 * The maximum packed value (index `2^28 - 1` with all three flags set) is
 * `2^31 - 1`, which fits a *positive* signed 32-bit integer — safe for JS's
 * bitwise operators (which coerce to int32) and for a `Uint32Array`/Rust `u32`
 * on the wire, with no sign-bit ambiguity to reason about on either side.
 */

import { pixelToCell } from './gridGeometry';
import type { GridSpec } from './types';

export const TILE_INDEX_BITS = 28;
export const TILE_INDEX_MASK = (1 << TILE_INDEX_BITS) - 1; // 0x0FFF_FFFF

export const FLIP_H_BIT = 1 << 28;
export const FLIP_V_BIT = 1 << 29;
export const TRANSPOSE_BIT = 1 << 30;

/** Index 0 is always the empty tile (`docs/03-data-model.md` §4), no flags set. */
export const EMPTY_TILE_ID = 0;

export interface TileFlags {
  flipH?: boolean;
  flipV?: boolean;
  transpose?: boolean;
}

export interface UnpackedTileId {
  index: number;
  flipH: boolean;
  flipV: boolean;
  transpose: boolean;
}

/** Pack a tile index plus flip/rotate flags into one wire id. */
export function packTileId(index: number, flags: TileFlags = {}): number {
  if (index < 0 || index > TILE_INDEX_MASK || !Number.isInteger(index)) {
    throw new RangeError(`tile index ${index} out of range 0..${TILE_INDEX_MASK}`);
  }
  let id = index;
  if (flags.flipH) id |= FLIP_H_BIT;
  if (flags.flipV) id |= FLIP_V_BIT;
  if (flags.transpose) id |= TRANSPOSE_BIT;
  // `>>> 0` reads the bit pattern back as an unsigned value — packing can set
  // bit 30, which keeps the JS int32 representation positive already, but this
  // makes the "unsigned" contract explicit rather than incidental.
  return id >>> 0;
}

/** Unpack a wire id into its tile index and flip/rotate flags. */
export function unpackTileId(id: number): UnpackedTileId {
  return {
    index: id & TILE_INDEX_MASK,
    flipH: (id & FLIP_H_BIT) !== 0,
    flipV: (id & FLIP_V_BIT) !== 0,
    transpose: (id & TRANSPOSE_BIT) !== 0,
  };
}

/** Cols/rows a cel's grid has for a given tile size, clipping any partial edge tile. */
export function tileGridDims(
  cel: { width: number; height: number },
  grid: { tileWidth: number; tileHeight: number },
): { cols: number; rows: number } {
  return {
    cols: Math.max(0, Math.floor(cel.width / grid.tileWidth)),
    rows: Math.max(0, Math.floor(cel.height / grid.tileHeight)),
  };
}

/**
 * Document pixel → the tilemap grid cell it falls in (roadmap Phase 6, "Tile
 * stamp tool"; generalized to every `GridShape` in Phase 7). Cel-local, and
 * the inverse transform is shape-dependent (`model/gridGeometry.ts::
 * pixelToCell`) — matching `model/tilemapRender.ts::renderTilemapCel`'s own
 * forward placement (`cellOrigin`) exactly, including `offsetX`/`offsetY`,
 * which is now wired into every shape's placement math (both functions read
 * it identically, so a grid with a non-zero offset still targets the same
 * cell it renders into).
 */
export function docPixelToCell(
  docX: number,
  docY: number,
  cel: { x: number; y: number },
  grid: GridSpec,
): { col: number; row: number } {
  return pixelToCell(grid, docX - cel.x, docY - cel.y);
}
