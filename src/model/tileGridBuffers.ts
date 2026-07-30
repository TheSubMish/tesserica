/**
 * Tilemap-cel grid storage, deliberately outside React state — the
 * `model/pixelBuffers.ts` scheme, one axis over: a tilemap layer's `Cel`
 * (`model/types.ts`) holds no RGBA pixels of its own, only a flat array of
 * packed tile ids (`model/tileIds.ts`), one per grid cell, addressed by the
 * same `CelId` a raster layer would use for its pixel buffer.
 *
 * `Uint32Array`, not `Uint8ClampedArray`: a grid cell is a tile id
 * (`packTileId`), not a colour channel.
 */

import type { CelId } from './types';

const grids = new Map<CelId, Uint32Array>();
const revisions = new Map<CelId, number>();

export function gridRevision(id: CelId): number {
  return revisions.get(id) ?? 0;
}

export function bumpGridRevision(id: CelId): void {
  revisions.set(id, gridRevision(id) + 1);
}

/** All-empty (tile id 0) grid of `cols`×`rows` cells. */
export function allocateGrid(id: CelId, cols: number, rows: number): Uint32Array {
  const grid = new Uint32Array(Math.max(0, cols) * Math.max(0, rows));
  grids.set(id, grid);
  bumpGridRevision(id);
  return grid;
}

export function getGrid(id: CelId): Uint32Array | undefined {
  return grids.get(id);
}

/**
 * Re-register a grid under a cel id — used when undoing a tilemap layer's
 * deletion, mirroring `pixelBuffers.ts::setBuffer`.
 */
export function setGrid(id: CelId, grid: Uint32Array): void {
  grids.set(id, grid);
  bumpGridRevision(id);
}

export function releaseGrid(id: CelId): void {
  grids.delete(id);
  revisions.delete(id);
}

export function clearAllGrids(): void {
  grids.clear();
  revisions.clear();
}

/** Read one grid cell's packed tile id, or `undefined` outside the grid. */
export function getGridCell(
  grid: Uint32Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
): number | undefined {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return undefined;
  return grid[row * cols + col];
}

/** Write one grid cell's packed tile id in place. Out-of-bounds is a silent no-op. */
export function setGridCell(
  grid: Uint32Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
  tileId: number,
): void {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return;
  grid[row * cols + col] = tileId;
}
