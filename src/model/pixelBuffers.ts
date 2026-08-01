/**
 * Pixel storage, deliberately outside React and outside the zustand store.
 *
 * `docs/02-architecture.md` §4: layer pixel buffers live in plain
 * `Uint8ClampedArray`s referenced by id; only metadata (name, opacity,
 * visibility) is reactive. Putting megabytes of pixels into React state would
 * make every stroke an immutable copy of the whole document.
 *
 * The store instead carries a `revision` counter that the renderer watches.
 * Mutate a buffer here, bump the revision there, and the canvas redraws.
 */

import type { CelId } from './types';

const buffers = new Map<CelId, Uint8ClampedArray>();

/**
 * Per-cel change counters.
 *
 * The store's single `revision` says *something* changed; these say *what*.
 * The renderer needs the finer signal to cache each layer's upload separately
 * — otherwise one pencil dot on the top layer re-uploads every layer below it
 * (`docs/02-architecture.md` §7).
 */
const revisions = new Map<CelId, number>();

export function celRevision(id: CelId): number {
  return revisions.get(id) ?? 0;
}

export function bumpCelRevision(id: CelId): void {
  revisions.set(id, celRevision(id) + 1);
}

export function allocateBuffer(id: CelId, width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4); // transparent
  buffers.set(id, buf);
  bumpCelRevision(id);
  return buf;
}

export function getBuffer(id: CelId): Uint8ClampedArray | undefined {
  return buffers.get(id);
}

/**
 * Re-register a buffer under a cel id. Used when undoing a layer deletion:
 * the command held the pixels while the layer was gone and hands them back.
 */
export function setBuffer(id: CelId, buf: Uint8ClampedArray): void {
  buffers.set(id, buf);
  bumpCelRevision(id);
}

export function releaseBuffer(id: CelId): void {
  buffers.delete(id);
  bumpCelRevision(id);
}

export function clearAllBuffers(): void {
  buffers.clear();
  revisions.clear();
}

/**
 * Write one pixel. Straight (non-premultiplied) alpha throughout —
 * `docs/02-architecture.md` §9. Out-of-bounds writes are silently ignored so
 * tools can draw freely without clamping at every call site.
 *
 * `value`'s own length is how many bytes a pixel occupies — four for an RGBA
 * tuple, exactly as always, or one for an indexed-mode cel's raw palette
 * index (`docs/08-roadmap.md` Phase 7, `model/celStorage.ts`). Every geometry
 * helper built on this (`tools/raster.ts`, `tools/shapes.ts`, `tools/fill.ts`)
 * inherits the same generality for free rather than needing a second,
 * parallel set of functions per storage kind.
 */
export function setPixel(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: readonly number[],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const bpp = value.length;
  const i = (y * width + x) * bpp;
  for (let k = 0; k < bpp; k++) buf[i + k] = value[k];
}

/** `bytesPerPixel` defaults to 4 (RGBA) — every pre-Phase-7 call site is unaffected. */
export function getPixel(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  bytesPerPixel = 4,
): number[] | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * bytesPerPixel;
  const out: number[] = [];
  for (let k = 0; k < bytesPerPixel; k++) out.push(buf[i + k]);
  return out;
}
