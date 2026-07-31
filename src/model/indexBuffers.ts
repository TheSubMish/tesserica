/**
 * Palette-index storage for indexed-mode raster cels (`docs/08-roadmap.md`
 * Phase 7 "Indexed color mode + live palette swapping", `docs/10-decisions.md`
 * D9).
 *
 * Mirrors `model/pixelBuffers.ts` one axis over: same id-keyed map, same
 * revision-counter idiom, same "buffers never enter React state" discipline
 * (`docs/02-architecture.md` §4) — the only difference is what a byte *means*.
 * A pixel here is one `Uint8Array` byte, not four `Uint8ClampedArray` bytes,
 * so an indexed cel costs a quarter the memory of the RGBA storage it
 * replaces (`docs/03-data-model.md` §9's own "indexed mode: 1 byte/pixel
 * instead of 4").
 *
 * **Policy: index 0 is reserved for "transparent / no ink".** A palette's
 * *own* colours are addressed starting at index 1 (`palette.colors[0]`
 * resolves to raw index `1`, not `0`), which caps an indexed sprite at 255
 * usable colours in a `Uint8Array` — 256 raw values minus the one reserved
 * for transparency. This is the exact ambiguity `docs/10-decisions.md` D9
 * flags as needing "a policy": rather than requiring every palette to
 * reserve its own transparent slot (which every existing bundled/imported
 * palette in this app does not do — they are plain opaque swatch lists,
 * `model/types.ts::Palette`), transparency is a property of the *index
 * space*, not the palette's own colour list. See `model/indexedColor.ts` for
 * where this constant is actually consumed.
 */

import type { CelId } from './types';

export const TRANSPARENT_INDEX = 0;

const buffers = new Map<CelId, Uint8Array>();
const revisions = new Map<CelId, number>();

export function indexRevision(id: CelId): number {
  return revisions.get(id) ?? 0;
}

export function bumpIndexRevision(id: CelId): void {
  revisions.set(id, indexRevision(id) + 1);
}

/** A fresh, fully-transparent (all `TRANSPARENT_INDEX`) index buffer. */
export function allocateIndexBuffer(id: CelId, width: number, height: number): Uint8Array {
  const buf = new Uint8Array(width * height); // zero-filled — TRANSPARENT_INDEX
  buffers.set(id, buf);
  bumpIndexRevision(id);
  return buf;
}

export function getIndexBuffer(id: CelId): Uint8Array | undefined {
  return buffers.get(id);
}

/** Re-register a buffer under a cel id — the indexed-storage counterpart to `pixelBuffers.setBuffer`. */
export function setIndexBuffer(id: CelId, buf: Uint8Array): void {
  buffers.set(id, buf);
  bumpIndexRevision(id);
}

export function releaseIndexBuffer(id: CelId): void {
  buffers.delete(id);
  bumpIndexRevision(id);
}

export function clearAllIndexBuffers(): void {
  buffers.clear();
  revisions.clear();
}
