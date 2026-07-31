/**
 * Tileset creation helpers (`docs/03-data-model.md` §4).
 *
 * Kept separate from `state/documentStore.ts` the same way `model/tags.ts`
 * is: pure construction logic with no store/undo awareness, so it is testable
 * standalone and reusable from both the (future) tile stamp tool and this
 * phase's programmatic CRUD.
 */

import { allocateEmptyTileBuffer, getTileBuffer } from './tileBuffers';
import { flipTileH, flipTileV } from './tilemapRender';
import type { Tileset, TilesetId } from './types';

/**
 * A brand-new tileset with its mandatory empty tile at index 0
 * (`docs/03-data-model.md` §4: "index 0 is always the empty tile"). The empty
 * tile's own buffer is allocated immediately — it is a real, fully
 * transparent, drawable tile, not a placeholder id with nothing behind it.
 */
export function createTileset(
  makeId: () => string,
  name: string,
  tileWidth: number,
  tileHeight: number,
): Tileset {
  const id: TilesetId = makeId();
  const emptyTileId = makeId();
  allocateEmptyTileBuffer(emptyTileId, tileWidth, tileHeight);
  return {
    id,
    name,
    tileWidth,
    tileHeight,
    tiles: [{ id: emptyTileId }],
  };
}

/**
 * Crop `rect` (in `buffer`'s own local coordinates) out of a pixel buffer,
 * or `undefined` when `rect` does not fit entirely inside it — the tile
 * stamp tool's "capture a selection as a tile" workflow
 * (`docs/08-roadmap.md` Phase 6). Straight alpha throughout, same as every
 * other pixel buffer in the app — this is a crop, not a resample, so there is
 * no premultiplication concern to get wrong.
 */
export function extractTilePixels(
  buffer: Uint8ClampedArray,
  bufferWidth: number,
  bufferHeight: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8ClampedArray | undefined {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > bufferWidth ||
    rect.y + rect.height > bufferHeight
  ) {
    return undefined;
  }
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const srcRowStart = ((rect.y + y) * bufferWidth + rect.x) * 4;
    const dstRowStart = y * rect.width * 4;
    out.set(buffer.subarray(srcRowStart, srcRowStart + rect.width * 4), dstRowStart);
  }
  return out;
}

/** Byte-exact comparison — pixel content, not just length. */
export function tilePixelsEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface TileMatch {
  /** Index of the existing `TileEntry` that reproduces the captured pixels. */
  index: number;
  /** Apply these flags (`model/tileIds.ts`) to the existing entry to reproduce them. */
  flipH: boolean;
  flipV: boolean;
}

/**
 * Auto-deduplication (`docs/08-roadmap.md` Phase 6): find an existing tile in
 * `tileset` whose stored pixels equal `pixels`, either directly or under a
 * horizontal/vertical flip (or both — a 180° rotation). Diagonal transpose is
 * **not** attempted — the roadmap's own "flip-only, not full rotate-aware" is
 * the honestly-reported partial here, since a transpose is only well-defined
 * for a square tile (`model/tilemapRender.ts::transposeTile`) and chasing that
 * asymmetry was judged not worth it against "reuse the common case, add a new
 * entry for the rest."
 */
export function findMatchingTile(
  tileset: Tileset,
  pixels: Uint8ClampedArray,
): TileMatch | undefined {
  const { tileWidth: w, tileHeight: h } = tileset;
  for (let index = 0; index < tileset.tiles.length; index++) {
    const buf = getTileBuffer(tileset.tiles[index].id);
    if (!buf || buf.length !== pixels.length) continue;
    if (tilePixelsEqual(buf, pixels)) return { index, flipH: false, flipV: false };
    if (tilePixelsEqual(flipTileH(buf, w, h), pixels)) return { index, flipH: true, flipV: false };
    if (tilePixelsEqual(flipTileV(buf, w, h), pixels)) return { index, flipH: false, flipV: true };
    if (tilePixelsEqual(flipTileV(flipTileH(buf, w, h), w, h), pixels)) {
      return { index, flipH: true, flipV: true };
    }
  }
  return undefined;
}
