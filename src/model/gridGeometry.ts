/**
 * Grid-shape geometry (`docs/03-data-model.md` §4, roadmap Phase 7 "Isometric
 * and hexagonal tile grids").
 *
 * A tile's *logical* address is always a plain `(col, row)` pair into the
 * dense `Uint32Array` grid buffer (`model/tileGridBuffers.ts`) — that never
 * changes across shapes. What changes per `GridSpec.shape` is only the
 * mapping between that logical address and where the tile's own
 * `tileWidth`×`tileHeight` pixel buffer actually lands in cel-local pixel
 * space (`cellOrigin`, the forward transform used by
 * `model/tilemapRender.ts`), and the inverse — which cell a cel-local pixel
 * falls in (`pixelToCell`, used by the stamp tool's picking and the
 * eyedropper).
 *
 * Every tile is still a plain rectangular RGBA buffer (`model/tileBuffers.ts`)
 * blitted nearest-neighbour, 1:1, never resampled — invariant 1 in
 * `CLAUDE.md` holds for every shape here. What "isometric"/"hexagonal" mean
 * is exclusively *where* that rectangle's top-left corner is placed; a
 * diamond or hexagon silhouette is whatever the tile artist painted into that
 * rectangle's own alpha channel (the same convention Tiled and Godot's
 * isometric/hex tilemap layers use for image-based, as opposed to
 * procedurally drawn, tiles).
 *
 * ## Isometric — 2:1 diamond projection
 *
 * The standard pixel-art isometric convention (RollerCoaster Tycoon-style,
 * and what Tiled's own isometric orientation assumes for image tiles): a
 * tile's screen position is a plain 2D shear of its grid coordinate,
 *
 * ```
 * originX(col, row) = offsetX + (col − row) · tileWidth / 2
 * originY(col, row) = offsetY + (col + row) · tileHeight / 2
 * ```
 *
 * i.e. moving one column right shifts half a tile right *and* half a tile
 * down; moving one row down shifts half a tile left and half a tile down.
 * This is an invertible linear map, so the inverse (`pixelToCell`) is exact,
 * closed-form: solve for `(col − row)` and `(col + row)` from a point's
 * offset from a tile's *centre* (not its corner — the diamond lattice is
 * centred, so rounding after this substitution picks the nearest diamond
 * centre, which is the correct "which tile is this point over" answer for a
 * lattice of half-tile-offset rhombi), then round to the nearest integers.
 *
 * Because adjacent tiles' *bounding boxes* overlap by design (that's what
 * makes the diamonds interlock), `renderTilemapCel` cannot simply overwrite
 * pixels in placement order — it alpha-composites (`compositeOver`) and
 * draws back-to-front in ascending `col + row` order (`tileDrawOrder`), the
 * standard isometric painter's-algorithm order: a tile's screen depth is
 * exactly its `col + row`, so overlapping regions always show whichever tile
 * is "in front" (nearer the bottom of the screen) on top.
 *
 * ## Hexagonal — pointy-top, odd-row horizontal offset ("odd-r")
 *
 * Chosen over flat-top / axial coordinates because it composes with the
 * existing row-major `(col, row)` dense grid buffer with no new coordinate
 * system to store or round-trip through `.tess` — only the placement
 * transform changes, exactly like isometric. "Odd-r" is Red Blob Games'
 * name (`https://www.redblobgames.com/grids/hexagons/`, the standard
 * reference for offset-coordinate hex grids) for: odd-numbered rows shift
 * right by half a tile width; the vertical step between rows is 3/4 of a
 * tile's height, since a pointy-top hex tile's top and bottom triangular
 * caps interlock with the row above/below.
 *
 * ```
 * originX(col, row) = offsetX + col · tileWidth + (row odd ? tileWidth / 2 : 0)
 * originY(col, row) = offsetY + row · (tileHeight · 3 / 4)
 * ```
 *
 * Same-row tiles never overlap (a full `tileWidth` apart); adjacent rows
 * overlap by a quarter tile height and half a tile width, so — as with
 * isometric — placement alpha-composites rather than overwrites. Unlike
 * isometric, plain ascending-row order is already correct back-to-front
 * order (a row only ever overlaps its immediate neighbours, and a strictly
 * later row is always "in front"), so `tileDrawOrder` leaves hex in its
 * natural row-major order.
 *
 * The inverse has no closed form as clean as isometric's shear (offset hex
 * coordinates are not a linear map), so `pixelToCell` uses the standard,
 * robust technique instead: estimate the nearest row/column from the pixel
 * position, then check the 3×3 neighbourhood of candidate cells and return
 * whichever tile's *bounding-box centre* is closest to the query point.
 * Every forward-transform output round-trips exactly through this search
 * (verified in `gridGeometry.test.ts`), since the true candidate is always
 * within that neighbourhood and distances are compared exactly.
 */

import type { GridShape, GridSpec } from './types';

export interface CellOrigin {
  x: number;
  y: number;
}

export interface CellAddress {
  col: number;
  row: number;
}

/** Fraction of a pointy-top hex tile's height that separates successive rows. */
const HEX_ROW_STEP = 0.75;

function isOddRow(row: number): boolean {
  // `row` can be negative (a point above/left of the grid's origin) — plain
  // `row % 2` yields -1 for odd negative rows in JS, so normalize to 0/1.
  return ((row % 2) + 2) % 2 === 1;
}

/**
 * Forward transform: a grid cell's `(col, row)` address → its
 * `tileWidth`×`tileHeight` bounding box's top-left corner, in the same
 * cel-local pixel space `tileGridDims`/`renderTilemapCel` already use.
 */
export function cellOrigin(grid: GridSpec, col: number, row: number): CellOrigin {
  const { tileWidth: tw, tileHeight: th, offsetX, offsetY } = grid;
  switch (grid.shape) {
    case 'isometric':
      return {
        x: offsetX + (col - row) * (tw / 2),
        y: offsetY + (col + row) * (th / 2),
      };
    case 'hexagonal':
      return {
        x: offsetX + col * tw + (isOddRow(row) ? tw / 2 : 0),
        y: offsetY + row * (th * HEX_ROW_STEP),
      };
    case 'rect':
    default:
      return { x: offsetX + col * tw, y: offsetY + row * th };
  }
}

/** Nearest hex-cell search — see the module doc's "Hexagonal" section. */
function nearestHexCell(grid: GridSpec, x: number, y: number): CellAddress {
  const { tileWidth: tw, tileHeight: th } = grid;
  const vertStep = th * HEX_ROW_STEP;
  const approxRow = vertStep > 0 ? Math.round((y - grid.offsetY - th / 2) / vertStep) : 0;

  let best: CellAddress = { col: 0, row: approxRow };
  let bestDistSq = Infinity;
  for (let row = approxRow - 1; row <= approxRow + 1; row++) {
    const rowOriginX = grid.offsetX + (isOddRow(row) ? tw / 2 : 0);
    const approxCol = tw > 0 ? Math.round((x - rowOriginX - tw / 2) / tw) : 0;
    for (let col = approxCol - 1; col <= approxCol + 1; col++) {
      const origin = cellOrigin(grid, col, row);
      const cx = origin.x + tw / 2;
      const cy = origin.y + th / 2;
      const dx = x - cx;
      const dy = y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { col, row };
      }
    }
  }
  return best;
}

/**
 * Inverse transform: a cel-local pixel → the grid cell address it falls in
 * (the stamp tool's picking/painting target, and the eyedropper's own
 * cell lookup). `rect` matches the original `docPixelToCell` behaviour
 * exactly (floor toward negative infinity, so above/left of the grid yields
 * negative addresses rather than clamping).
 */
export function pixelToCell(grid: GridSpec, x: number, y: number): CellAddress {
  const { tileWidth: tw, tileHeight: th, offsetX, offsetY } = grid;
  switch (grid.shape) {
    case 'isometric': {
      // Solve for (col - row) and (col + row) relative to a tile's *centre*
      // — see the module doc. Degenerate (zero-size) tiles fall back to the
      // grid origin rather than dividing by zero.
      if (tw <= 0 || th <= 0) return { col: 0, row: 0 };
      const cx = x - offsetX - tw / 2;
      const cy = y - offsetY - th / 2;
      const u = cx / (tw / 2);
      const v = cy / (th / 2);
      return { col: Math.round((u + v) / 2), row: Math.round((v - u) / 2) };
    }
    case 'hexagonal':
      if (tw <= 0 || th <= 0) return { col: 0, row: 0 };
      return nearestHexCell(grid, x, y);
    case 'rect':
    default:
      return {
        col: Math.floor((x - offsetX) / tw),
        row: Math.floor((y - offsetY) / th),
      };
  }
}

/**
 * Back-to-front tile draw order for one grid's `cols`×`rows` extent
 * (`renderTilemapCel`). `rect` and `hexagonal` are already correct in plain
 * row-major order (see the module doc); `isometric` needs an explicit sort
 * by screen depth (`col + row`, ties broken by `col` for determinism).
 */
export function tileDrawOrder(shape: GridShape, cols: number, rows: number): CellAddress[] {
  const cells: CellAddress[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) cells.push({ col, row });
  }
  if (shape === 'isometric') {
    cells.sort((a, b) => a.col + a.row - (b.col + b.row) || a.col - b.col);
  }
  return cells;
}

/** Whether a shape's tile bounding boxes can overlap and so need alpha compositing. */
export function shapeOverlaps(shape: GridShape): boolean {
  return shape === 'isometric' || shape === 'hexagonal';
}

/**
 * A sensible default `offsetX`/`offsetY` for a brand-new tilemap layer of the
 * given shape, sized against the canvas it will actually be painted on
 * (`panels/TilesetPanel.tsx::createTilemapLayer` — cels are always
 * sprite-sized, `model/types.ts`'s own `Cel` doc). Not load-bearing for
 * correctness — a grid works at any offset — only for *usability*: an
 * isometric diamond grid whose column 0 starts at the canvas's left edge
 * immediately clips half of itself off-canvas to the left as `row` grows
 * (`cellOrigin`'s `(col − row)` term goes negative), so `col = 0` is instead
 * centred horizontally, letting the diamond expand both ways. `rect` and
 * `hexagonal` never go negative from `(0, 0)` outward, so they keep the
 * origin at the canvas's own top-left, unchanged from Phase 6.
 */
export function defaultGridOffset(
  shape: GridShape,
  tileWidth: number,
  _tileHeight: number,
  canvasWidth: number,
  _canvasHeight: number,
): { offsetX: number; offsetY: number } {
  if (shape === 'isometric') {
    return { offsetX: Math.round(canvasWidth / 2 - tileWidth / 2), offsetY: 0 };
  }
  return { offsetX: 0, offsetY: 0 };
}
