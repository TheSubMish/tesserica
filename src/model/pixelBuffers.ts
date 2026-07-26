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

export function allocateBuffer(id: CelId, width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4); // transparent
  buffers.set(id, buf);
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
}

export function releaseBuffer(id: CelId): void {
  buffers.delete(id);
}

export function clearAllBuffers(): void {
  buffers.clear();
}

/**
 * Write one pixel. Straight (non-premultiplied) alpha throughout —
 * `docs/02-architecture.md` §9. Out-of-bounds writes are silently ignored so
 * tools can draw freely without clamping at every call site.
 */
export function setPixel(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  buf[i] = color[0];
  buf[i + 1] = color[1];
  buf[i + 2] = color[2];
  buf[i + 3] = color[3];
}

export function getPixel(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}
