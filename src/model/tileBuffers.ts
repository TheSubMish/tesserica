/**
 * Tile-entry pixel storage, deliberately outside React state — same reasoning
 * as `model/pixelBuffers.ts`, one level down: a `TileEntry` (`model/types.ts`)
 * is metadata only (an id), and its actual RGBA pixels live here, keyed by
 * that id, addressed the same way a `Cel`'s pixels are addressed by
 * `CelId`/`celBufferId`.
 *
 * Straight (non-premultiplied) alpha throughout, matching every other pixel
 * buffer in the app (`docs/02-architecture.md` §9).
 */

import type { TileEntryId } from './types';

const buffers = new Map<TileEntryId, Uint8ClampedArray>();
const revisions = new Map<TileEntryId, number>();

export function tileEntryRevision(id: TileEntryId): number {
  return revisions.get(id) ?? 0;
}

export function bumpTileEntryRevision(id: TileEntryId): void {
  revisions.set(id, tileEntryRevision(id) + 1);
}

/** A fully transparent tile, `tileWidth`×`tileHeight`×4 bytes. */
export function allocateEmptyTileBuffer(
  id: TileEntryId,
  tileWidth: number,
  tileHeight: number,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(tileWidth * tileHeight * 4);
  buffers.set(id, buf);
  bumpTileEntryRevision(id);
  return buf;
}

export function getTileBuffer(id: TileEntryId): Uint8ClampedArray | undefined {
  return buffers.get(id);
}

export function setTileBuffer(id: TileEntryId, buf: Uint8ClampedArray): void {
  buffers.set(id, buf);
  bumpTileEntryRevision(id);
}

export function releaseTileBuffer(id: TileEntryId): void {
  buffers.delete(id);
  revisions.delete(id);
}

export function clearAllTileBuffers(): void {
  buffers.clear();
  revisions.clear();
}
