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

import { cellOrigin, pixelToCell } from './gridGeometry';
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

/**
 * Cols/rows a cel's grid has for a given tile size and shape, clipping any
 * partial edge tile.
 *
 * Shape-aware (roadmap Phase 7 gap-closure, `model/gridGeometry.ts`'s own
 * module doc and `docs/03-data-model.md` §4): for `rect`, a tile's forward-
 * placed bounding box (`cellOrigin`) grows linearly and independently along
 * each axis, so this reduces to the original plain `floor(cel size / tile
 * size)` division. For `isometric`/`hexagonal`, tile bounding boxes overlap
 * their neighbours by design (`shapeOverlaps`) and each shape's own forward
 * transform packs cells more tightly than a flat "N tiles of tileWidth/
 * tileHeight each" guess would assume — isometric steps `tileWidth/2`/
 * `tileHeight/2` per column and row rather than a full tile, and hexagonal
 * steps rows by `tileHeight * 0.75`, not `tileHeight`. Using the rect-only
 * formula for those shapes *undercounts* how many cells actually fit: a real
 * regression, caught by a test needing extra cel height to make row 1
 * addressable at all (`tilemapRender.test.ts`), even though row 1's actual
 * pixel footprint already fit in the smaller cel.
 *
 * The fix walks the *same* forward transform every renderer/picker already
 * uses (`cellOrigin`) along each axis in turn — columns at a fixed `row = 0`,
 * rows at a fixed `col = 0` — counting how many consecutive cells starting
 * from the origin have their full `tileWidth`×`tileHeight` bounding box
 * inside `[0, cel.width) × [0, cel.height)`, and stopping at the first one
 * that does not. Because the dense grid buffer (`model/tileGridBuffers.ts`)
 * is addressed as one contiguous `cols`×`rows` rectangle starting at
 * `(0, 0)`, "the first cell along an axis whose box doesn't fit" is exactly
 * the right stopping rule — there is no way to represent "skip row 1, keep
 * row 2" in that buffer, so a later cell independently fitting again
 * (possible for hexagonal, whose odd/even row parity can flip a fit back to
 * true) must not extend the count.
 */
export function tileGridDims(
  cel: { width: number; height: number },
  grid: GridSpec,
): { cols: number; rows: number } {
  const { tileWidth: tw, tileHeight: th } = grid;
  if (cel.width <= 0 || cel.height <= 0 || tw <= 0 || th <= 0) {
    return { cols: 0, rows: 0 };
  }

  const fitsBox = (col: number, row: number): boolean => {
    const { x, y } = cellOrigin(grid, col, row);
    return x >= 0 && y >= 0 && x + tw <= cel.width && y + th <= cel.height;
  };

  let cols = 0;
  while (fitsBox(cols, 0)) cols++;
  let rows = 0;
  while (fitsBox(0, rows)) rows++;
  return { cols, rows };
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
