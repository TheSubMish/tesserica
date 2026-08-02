/**
 * Undoable tileset and tilemap-layer operations (`docs/03-data-model.md` §4,
 * roadmap Phase 6 "Tileset model, tilemap layers, rect grid").
 *
 * Mirrors `layerCommands.ts`/`frameCommands.ts`'s vocabulary one axis over:
 * an add/remove pair for each existence question (a tileset, a tile within
 * one), plus a single coalescible-free property command for painting a grid
 * cell. There is no tile *stamp tool* yet (the next roadmap item) — these are
 * the primitives it will call, exercised here only programmatically, the same
 * "data model before the tool that reaches it" shape Phase 4's frame/cel work
 * shipped in before the Timeline panel existed.
 *
 * Creating a tilemap *layer* deliberately reuses `layerCommands.ts`'s
 * `AddLayerCommand` rather than adding a parallel command: a tilemap layer is
 * a `Layer` like any other (`LayerExistence` there was generalized to snapshot
 * grid buffers instead of pixel buffers when `layer.kind === 'tilemap'`), so
 * the existing add/delete/undo machinery already works for it unchanged.
 */

import { setTileBuffer } from '../model/tileBuffers';
import { getGrid, getGridCell } from '../model/tileGridBuffers';
import { tileGridDims } from '../model/tileIds';
import { createTileset, findMatchingTile } from '../model/tilesets';
import {
  celBufferId,
  type CelId,
  type GridSpec,
  type LayerId,
  type TileEntry,
  type Tileset,
  type TilesetId,
} from '../model/types';
import { makeId, useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { AddLayerCommand } from './layerCommands';
import type { Command, DocumentApi } from './command';

export class AddTilesetCommand implements Command {
  readonly label = 'Add Tileset';
  // Tile buffers created alongside a tileset are never released on remove
  // (mirrors `layerCommands.ts`'s buffer-retention convention) — a
  // redo/re-add always finds the identical pixels still in
  // `model/tileBuffers.ts`, so there is nothing to charge to the undo budget.
  readonly memoryCost = 0;

  constructor(
    private readonly tileset: Tileset,
    private readonly index: number,
  ) {}

  apply(doc: DocumentApi): void {
    doc.insertTileset(this.tileset, this.index);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.removeTilesetMetadata(this.tileset.id);
    doc.touch();
  }
}

export class AddTileCommand implements Command {
  readonly label = 'Add Tile';
  readonly memoryCost = 0;

  constructor(
    private readonly tilesetId: TilesetId,
    private readonly entry: TileEntry,
    private readonly index: number,
  ) {}

  apply(doc: DocumentApi): void {
    doc.insertTileEntry(this.tilesetId, this.entry, this.index);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.removeTileEntryMetadata(this.tilesetId, this.entry.id);
    doc.touch();
  }
}

/**
 * One stamp-tool gesture's worth of grid-cell edits, applied/inverted
 * together as a single undo step (`docs/03-data-model.md` §6, "one drag = one
 * undo step") — `SetTileCellCommand`'s own doc comment named this as future
 * work; `history/tileStrokeRecorder.ts` is what builds one of these from a
 * drag, the same snapshot/diff shape `history/strokeRecorder.ts` uses for
 * pixel buffers.
 */
export class PaintTileCellsCommand implements Command {
  readonly label = 'Stamp Tile';
  readonly memoryCost: number;

  constructor(
    private readonly celId: CelId,
    private readonly cells: readonly { col: number; row: number; before: number; after: number }[],
  ) {
    // 4 numbers/cell, roughly — small and bounded by how many cells one drag
    // can plausibly cover, unlike a pixel delta's per-byte cost.
    this.memoryCost = cells.length * 16;
  }

  apply(doc: DocumentApi): void {
    for (const c of this.cells) doc.setTilemapCell(this.celId, c.col, c.row, c.after);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    for (const c of this.cells) doc.setTilemapCell(this.celId, c.col, c.row, c.before);
    doc.touch();
  }
}

/** Paint one grid cell. Not coalescible — a stamp tool's drag would add that later. */
export class SetTileCellCommand implements Command {
  readonly label = 'Paint Tile';
  readonly memoryCost = 0;

  constructor(
    private readonly celId: CelId,
    private readonly col: number,
    private readonly row: number,
    private readonly before: number,
    private readonly after: number,
  ) {}

  apply(doc: DocumentApi): void {
    doc.setTilemapCell(this.celId, this.col, this.row, this.after);
    doc.touch();
  }

  invert(doc: DocumentApi): void {
    doc.setTilemapCell(this.celId, this.col, this.row, this.before);
    doc.touch();
  }
}

// ---------------------------------------------------------------------------
// Actions — what the UI (eventually the tile stamp tool / a tileset panel)
// calls.
// ---------------------------------------------------------------------------

/** Create a new tileset with its mandatory empty tile at index 0. */
export function addTileset(name: string, tileWidth: number, tileHeight: number): TilesetId {
  const tileset = createTileset(() => makeId('t'), name, tileWidth, tileHeight);
  const index = useDocumentStore.getState().sprite.tilesets.length;
  useHistoryStore.getState().run(new AddTilesetCommand(tileset, index));
  return tileset.id;
}

export interface AddTileOutcome {
  id: string;
  /** Index into the tileset's `tiles` array — new or reused. */
  index: number;
  /** True when an existing entry was reused rather than a new one created. */
  reused: boolean;
  /**
   * Flags that reproduce the captured pixels from the *reused* entry's stored
   * orientation. Always `false` for a newly created entry, since it stores
   * exactly what was captured.
   */
  flipH: boolean;
  flipV: boolean;
  transpose: boolean;
}

/**
 * Append one tile (raw RGBA pixels, already `tileWidth`×`tileHeight`×4) to an
 * existing tileset — or, when its pixel content exactly matches an existing
 * tile under any of the 8 flip/transpose reorientations a square tile can
 * take, reuse that tile's index instead of storing a duplicate `TileEntry`
 * (`docs/08-roadmap.md` Phase 6 "auto-deduplication", `model/tilesets.ts::
 * findMatchingTile`). Returns `undefined` if the tileset does not exist or
 * the pixel buffer is the wrong size.
 */
export function addTileToTileset(
  tilesetId: TilesetId,
  pixels: Uint8ClampedArray,
): AddTileOutcome | undefined {
  const doc = useDocumentStore.getState();
  const tileset = doc.sprite.tilesets.find((t) => t.id === tilesetId);
  if (!tileset) return undefined;
  if (pixels.length !== tileset.tileWidth * tileset.tileHeight * 4) return undefined;

  const match = findMatchingTile(tileset, pixels);
  if (match) {
    return {
      id: tileset.tiles[match.index].id,
      index: match.index,
      reused: true,
      flipH: match.flipH,
      flipV: match.flipV,
      transpose: match.transpose,
    };
  }

  const id = makeId('t');
  setTileBuffer(id, pixels);
  const entry: TileEntry = { id };
  const index = tileset.tiles.length;
  useHistoryStore.getState().run(new AddTileCommand(tilesetId, entry, index));
  return { id, index, reused: false, flipH: false, flipV: false, transpose: false };
}

/** Create a tilemap layer bound to `tilesetId`, as a sibling of the active layer. */
export function addTilemapLayer(
  tilesetId: TilesetId,
  grid: GridSpec,
  name?: string,
): LayerId | undefined {
  const doc = useDocumentStore.getState();
  if (!doc.sprite.tilesets.some((t) => t.id === tilesetId)) return undefined;

  const active = doc.sprite.layers.find((l) => l.id === doc.activeLayerId);
  const { layer, cels } = doc.createTilemapLayer(tilesetId, grid, name, active?.parentId ?? null);
  const index = doc.layerIndex(doc.activeLayerId) + 1;
  useHistoryStore.getState().run(new AddLayerCommand(layer, cels, index));
  return layer.id;
}

/**
 * Paint (or clear, with `EMPTY_TILE_ID`) one grid cell of a tilemap cel.
 * Refuses silently on an out-of-bounds cell, a non-tilemap cel, or a no-op —
 * the same posture `setFrameDuration` takes on a value that would not change
 * anything (`history/frameCommands.ts`).
 */
export function paintTilemapCell(celId: CelId, col: number, row: number, tileId: number): void {
  const doc = useDocumentStore.getState();
  const cel = doc.sprite.cels.find((c) => c.id === celId);
  if (!cel) return;
  const layer = doc.sprite.layers.find((l) => l.id === cel.layerId);
  if (layer?.kind !== 'tilemap') return;

  const bufferId = celBufferId(cel);
  const grid = getGrid(bufferId);
  if (!grid) return;
  const { cols, rows } = tileGridDims(cel, layer.grid);
  const before = getGridCell(grid, cols, rows, col, row);
  if (before === undefined || before === tileId) return;

  useHistoryStore.getState().run(new SetTileCellCommand(celId, col, row, before, tileId));
}
