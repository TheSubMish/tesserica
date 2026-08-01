/**
 * Resolve a tilemap layer's grid + tileset into an RGBA buffer for one cel
 * (`docs/03-data-model.md` §4, roadmap Phase 6).
 *
 * Shared by `canvas/renderer.ts`, `canvas/flatten.ts` and `canvas/sample.ts` —
 * the same three places every prior layer-kind addition (`group`,
 * `conversion`) touched — so a tilemap layer reads identically on screen, in
 * an exported PNG, and under the eyedropper.
 *
 * **Nearest-neighbour only, and trivially so**: a tile is blitted into its
 * grid cell at 1:1 scale (the cel's grid cell size always equals the
 * tileset's own tile size — no resampling ever happens), and flips are exact
 * axis/diagonal array transforms on the tile's own buffer, never a canvas
 * transform matrix that could introduce sampling artifacts.
 */

import { getGridCell } from './tileGridBuffers';
import { getTileBuffer } from './tileBuffers';
import { EMPTY_TILE_ID, tileGridDims, unpackTileId } from './tileIds';
import { cellOrigin, shapeOverlaps, tileDrawOrder } from './gridGeometry';
import { compositeOver } from '../canvas/compositeOver';
import type { GridSpec, Tileset } from './types';

/** Mirror the tile across its vertical centre line (left ↔ right). */
export function flipTileH(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (y * width + (width - 1 - x)) * 4;
      out[d] = buf[s];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 2];
      out[d + 3] = buf[s + 3];
    }
  }
  return out;
}

/** Mirror the tile across its horizontal centre line (top ↔ bottom). */
export function flipTileV(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = ((height - 1 - y) * width + x) * 4;
      out[d] = buf[s];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 2];
      out[d + 3] = buf[s + 3];
    }
  }
  return out;
}

/**
 * Reflect the tile across its main diagonal (swap x/y). Only well-defined for
 * a square tile — the grid cell this tile is blitted into keeps the
 * tileset's own `tileWidth`×`tileHeight`, so a non-square tile that also
 * swapped its own extent would no longer fit its cell. `docs/03-data-model.md`
 * §4 does not address this combination, so the smallest reasonable fallback
 * — treat the transpose flag as a no-op on a non-square tile, while
 * `flipH`/`flipV` still apply — is documented here rather than invented
 * silently.
 */
export function transposeTile(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (width !== height) return buf;
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (x * width + y) * 4;
      out[d] = buf[s];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 2];
      out[d + 3] = buf[s + 3];
    }
  }
  return out;
}

/**
 * A tile's pixels with its packed flip flags applied, or `null` when the tile
 * index is out of range or has no buffer (nothing to draw). Order: transpose,
 * then flip horizontal, then flip vertical — an arbitrary but fixed and
 * documented composition, since the doc's own bit sketch defines each flag's
 * meaning alone, not a combined order.
 */
export function resolveTilePixels(tileset: Tileset, tileId: number): Uint8ClampedArray | null {
  const { index, flipH, flipV, transpose } = unpackTileId(tileId);
  const entry = tileset.tiles[index];
  if (!entry) return null;
  let buf = getTileBuffer(entry.id);
  if (!buf) return null;

  const { tileWidth: w, tileHeight: h } = tileset;
  if (transpose) buf = transposeTile(buf, w, h);
  if (flipH) buf = flipTileH(buf, w, h);
  if (flipV) buf = flipTileV(buf, w, h);
  return buf;
}

/**
 * Render one tilemap cel's grid content into an RGBA buffer at `cel`'s own
 * size. A missing tileset or grid buffer (e.g. a layer whose tileset was
 * deleted from under it) renders as fully transparent rather than throwing —
 * the same "recoverable, not fatal" posture `commands::project`'s missing-cel
 * warning takes on the Rust side.
 *
 * `grid.shape` (`model/gridGeometry.ts`) drives two things beyond a `rect`
 * grid's simple non-overlapping blit: **placement** (`cellOrigin` instead of
 * `col * tileWidth`/`row * tileHeight`) and, for `isometric`/`hexagonal`
 * where neighbouring tiles' bounding boxes legitimately overlap,
 * **compositing order and blend** — `tileDrawOrder` walks cells back-to-front
 * and each tile is alpha-composited (`compositeOver`) over what is already
 * there instead of overwriting it, so a tile's transparent corners never
 * erase a neighbour drawn underneath it. `rect` never overlaps, so it keeps
 * the original cheap overwrite with no behaviour change.
 */
export function renderTilemapCel(
  tileset: Tileset | undefined,
  grid: GridSpec,
  gridBuffer: Uint32Array | undefined,
  cel: { width: number; height: number },
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cel.width * cel.height * 4);
  if (!tileset || !gridBuffer) return out;

  const { cols, rows } = tileGridDims(cel, grid);
  const tw = tileset.tileWidth;
  const th = tileset.tileHeight;
  if (tw <= 0 || th <= 0) return out;

  const overlaps = shapeOverlaps(grid.shape);
  const order = tileDrawOrder(grid.shape, cols, rows);

  for (const { col, row } of order) {
    const tileId = getGridCell(gridBuffer, cols, rows, col, row);
    if (tileId === undefined || tileId === EMPTY_TILE_ID) continue;
    const pixels = resolveTilePixels(tileset, tileId);
    if (!pixels) continue;

    const origin = cellOrigin(grid, col, row);
    const ox = Math.round(origin.x);
    const oy = Math.round(origin.y);
    for (let y = 0; y < th; y++) {
      const dy = oy + y;
      if (dy >= cel.height) break;
      if (dy < 0) continue;
      for (let x = 0; x < tw; x++) {
        const dx = ox + x;
        if (dx >= cel.width) break;
        if (dx < 0) continue;
        const s = (y * tw + x) * 4;
        const d = (dy * cel.width + dx) * 4;
        if (!overlaps) {
          out[d] = pixels[s];
          out[d + 1] = pixels[s + 1];
          out[d + 2] = pixels[s + 2];
          out[d + 3] = pixels[s + 3];
          continue;
        }
        if (pixels[s + 3] === 0) continue; // fully transparent source: no-op
        const blended = compositeOver([pixels[s], pixels[s + 1], pixels[s + 2], pixels[s + 3]], 1, [
          out[d],
          out[d + 1],
          out[d + 2],
          out[d + 3],
        ]);
        out[d] = blended[0];
        out[d + 1] = blended[1];
        out[d + 2] = blended[2];
        out[d + 3] = blended[3];
      }
    }
  }
  return out;
}
