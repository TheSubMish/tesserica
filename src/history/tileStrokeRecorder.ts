/**
 * Turns one stamp-tool drag into one undo step (`docs/03-data-model.md` §6:
 * "one drag = one undo step") — `strokeRecorder.ts`'s snapshot/diff shape,
 * one buffer type over: a tilemap cel's content is a packed-tile-id
 * `Uint32Array` grid (`model/tileGridBuffers.ts`), not an RGBA pixel buffer,
 * so it gets its own snapshot/diff pair rather than reusing `makePixelDelta`.
 *
 * `begin` copies the grid once. The stamp session
 * (`tools/stampSession.ts`) then paints live, cell by cell, straight into the
 * real grid via `documentStore.setTilemapCell` — the same "mutate now, diff
 * later" shape every other tool uses. `finish` diffs the snapshot against the
 * grid and produces one `PaintTileCellsCommand` covering every cell the
 * gesture actually changed.
 */

import type { CelId } from '../model/types';
import { PaintTileCellsCommand } from './tilesetCommands';

export interface TileStrokeSnapshot {
  celId: CelId;
  cols: number;
  rows: number;
  /** The grid exactly as it was at pointer-down. */
  grid: Uint32Array;
}

export function beginTileStroke(
  celId: CelId,
  grid: Uint32Array,
  cols: number,
  rows: number,
): TileStrokeSnapshot {
  return { celId, cols, rows, grid: new Uint32Array(grid) };
}

/** Put the grid back to its pointer-down state — used by Escape-to-abandon. */
export function restoreTileStroke(snapshot: TileStrokeSnapshot, grid: Uint32Array): void {
  grid.set(snapshot.grid);
}

/**
 * Build the undo step for a finished gesture, or `null` when nothing actually
 * changed (a click that re-stamped an identical tile id).
 */
export function finishTileStroke(
  snapshot: TileStrokeSnapshot,
  grid: Uint32Array,
): PaintTileCellsCommand | null {
  const cells: { col: number; row: number; before: number; after: number }[] = [];
  for (let row = 0; row < snapshot.rows; row++) {
    for (let col = 0; col < snapshot.cols; col++) {
      const i = row * snapshot.cols + col;
      const before = snapshot.grid[i];
      const after = grid[i];
      if (before !== after) cells.push({ col, row, before, after });
    }
  }
  if (cells.length === 0) return null;
  return new PaintTileCellsCommand(snapshot.celId, cells);
}
