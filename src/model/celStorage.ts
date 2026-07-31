/**
 * Which physical store backs a cel's pixels — RGBA (`model/pixelBuffers.ts`)
 * or palette indices (`model/indexBuffers.ts`) — decided in exactly one place
 * so every caller (the document store, undo commands, the renderer, the
 * tools) agrees.
 *
 * **Scope decision**: only a `raster` layer in an `indexed`-mode sprite uses
 * indexed storage. `conversion` layers stay RGBA regardless of
 * `sprite.colorMode` — their pixels come from the conversion pipeline
 * (`docs/04-image-pipeline.md`), which is RGBA end to end (D9's own scope is
 * about hand-drawn painting, not the converter), and re-quantizing a
 * conversion layer's *output* into the sprite's separate indexed palette
 * would be a second, unrelated quantization step this dispatch does not
 * build. `tilemap`/`group` layers are unaffected either way — they already
 * have their own non-pixel representations (`model/tileGridBuffers.ts`, no
 * cels at all). A sprite's `colorMode` is fixed at creation
 * (`app/newSprite.ts`) and never changes for cels already in flight, so a
 * given cel id lives in exactly one of the two stores for its whole life.
 */

import {
  allocateBuffer,
  bumpCelRevision,
  celRevision,
  getBuffer,
  releaseBuffer,
  setBuffer,
} from './pixelBuffers';
import {
  allocateIndexBuffer,
  bumpIndexRevision,
  indexRevision,
  getIndexBuffer,
  releaseIndexBuffer,
  setIndexBuffer,
} from './indexBuffers';
import { renderIndexedCel } from './indexedRender';
import type { CelId, Layer, Sprite } from './types';

export type CelBuffer = Uint8ClampedArray | Uint8Array;

export function isIndexedLayer(sprite: Sprite, layer: Pick<Layer, 'kind'>): boolean {
  return layer.kind === 'raster' && sprite.colorMode === 'indexed';
}

export function bytesPerPixelFor(sprite: Sprite, layer: Pick<Layer, 'kind'>): 1 | 4 {
  return isIndexedLayer(sprite, layer) ? 1 : 4;
}

export function allocateCelBuffer(
  sprite: Sprite,
  layer: Pick<Layer, 'kind'>,
  id: CelId,
  width: number,
  height: number,
): CelBuffer {
  return isIndexedLayer(sprite, layer)
    ? allocateIndexBuffer(id, width, height)
    : allocateBuffer(id, width, height);
}

export function getCelBuffer(
  sprite: Sprite,
  layer: Pick<Layer, 'kind'>,
  id: CelId,
): CelBuffer | undefined {
  return isIndexedLayer(sprite, layer) ? getIndexBuffer(id) : getBuffer(id);
}

export function setCelBuffer(
  sprite: Sprite,
  layer: Pick<Layer, 'kind'>,
  id: CelId,
  buf: CelBuffer,
): void {
  if (isIndexedLayer(sprite, layer)) setIndexBuffer(id, buf as Uint8Array);
  else setBuffer(id, buf as Uint8ClampedArray);
}

export function releaseCelBuffer(sprite: Sprite, layer: Pick<Layer, 'kind'>, id: CelId): void {
  if (isIndexedLayer(sprite, layer)) releaseIndexBuffer(id);
  else releaseBuffer(id);
}

export function celBufferRevision(sprite: Sprite, layer: Pick<Layer, 'kind'>, id: CelId): number {
  return isIndexedLayer(sprite, layer) ? indexRevision(id) : celRevision(id);
}

export function bumpCelBufferRevision(sprite: Sprite, layer: Pick<Layer, 'kind'>, id: CelId): void {
  if (isIndexedLayer(sprite, layer)) bumpIndexRevision(id);
  else bumpCelRevision(id);
}

/**
 * A raster layer's cel resolved to displayable straight-alpha RGBA — a no-op
 * identity for an RGBA cel, a real palette lookup
 * (`model/indexedRender.ts::renderIndexedCel`) for an indexed one. Callers
 * that already special-case `tilemap`/`group` layers (`canvas/flatten.ts`,
 * `canvas/renderer.ts`, `canvas/sample.ts`) call this only for the `raster`/
 * `conversion` branch.
 */
export function resolveRasterToRgba(
  sprite: Sprite,
  layer: Pick<Layer, 'kind'>,
  buf: CelBuffer,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (isIndexedLayer(sprite, layer)) {
    return renderIndexedCel(buf as Uint8Array, sprite.palette, width, height);
  }
  return buf as Uint8ClampedArray;
}

/**
 * Look up a cel's buffer knowing only its already-decided bytes-per-pixel —
 * used by the undo system (`history/commands.ts::PixelDeltaCommand`), which
 * records `bytesPerPixel` once at stroke time and does not otherwise need a
 * `Layer` reference at apply/invert time.
 */
export function getBufferForBpp(id: CelId, bytesPerPixel: number): CelBuffer | undefined {
  return bytesPerPixel === 1 ? getIndexBuffer(id) : getBuffer(id);
}
