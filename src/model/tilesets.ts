/**
 * Tileset creation helpers (`docs/03-data-model.md` §4).
 *
 * Kept separate from `state/documentStore.ts` the same way `model/tags.ts`
 * is: pure construction logic with no store/undo awareness, so it is testable
 * standalone and reusable from both the (future) tile stamp tool and this
 * phase's programmatic CRUD.
 */

import { allocateEmptyTileBuffer } from './tileBuffers';
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
