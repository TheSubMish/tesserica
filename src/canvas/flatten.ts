/**
 * Flatten the sprite to a straight-alpha RGBA buffer at document scale.
 *
 * **Why not read it back off the display canvas.** Canvas2D stores pixels
 * *premultiplied*. A `putImageData` → `getImageData` round trip therefore
 * quantizes every semi-transparent pixel twice and loses colour precision on
 * exactly the pixels that matter — the soft edges. Alpha is straight
 * everywhere in this project (`docs/02-architecture.md` §9), and export is the
 * one place where "close enough for the screen" is not good enough, so the
 * composite is done arithmetically instead.
 *
 * The per-pixel maths is `compositeOver` from `sample.ts`, shared so that what
 * the eyedropper reports and what export writes cannot drift apart.
 */

import { celBufferId, type Cel, type Layer, type LayerId, type Sprite } from '../model/types';
import { getBuffer } from '../model/pixelBuffers';
import { getGrid } from '../model/tileGridBuffers';
import { renderTilemapCel } from '../model/tilemapRender';
import { childrenOf } from '../model/layerTree';
import { compositeOver } from './sample';

/** A leaf layer's own pixels placed at their cel offset in a sprite-sized buffer. */
function placeCel(
  buf: Uint8ClampedArray,
  cel: Cel,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < cel.height; y++) {
    const dy = cel.y + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < cel.width; x++) {
      const dx = cel.x + x;
      if (dx < 0 || dx >= width) continue;
      const s = (y * cel.width + x) * 4;
      const d = (dy * width + dx) * 4;
      out[d] = buf[s];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 2];
      out[d + 3] = buf[s + 3];
    }
  }
  return out;
}

/** `own`'s alpha scaled by `opacity` — its shape as a future clip base, at its own opacity. */
function ownContribution(own: Uint8ClampedArray, opacity: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(own.length);
  for (let i = 0; i < own.length; i += 4) {
    out[i] = own[i];
    out[i + 1] = own[i + 1];
    out[i + 2] = own[i + 2];
    out[i + 3] = Math.round(own[i + 3] * opacity);
  }
  return out;
}

function mergeNormal(
  out: Uint8ClampedArray,
  own: Uint8ClampedArray,
  opacity: number,
  blendMode: Layer['blendMode'],
): void {
  for (let d = 0; d < out.length; d += 4) {
    if (own[d + 3] === 0) continue;
    const [r, g, b, a] = compositeOver(
      [own[d], own[d + 1], own[d + 2], own[d + 3]],
      opacity,
      [out[d], out[d + 1], out[d + 2], out[d + 3]],
      blendMode,
    );
    out[d] = r;
    out[d + 1] = g;
    out[d + 2] = b;
    out[d + 3] = a;
  }
}

/** Same as `mergeNormal`, but `own`'s alpha is attenuated by `base`'s own alpha first. */
function mergeClipped(
  out: Uint8ClampedArray,
  own: Uint8ClampedArray,
  base: Uint8ClampedArray,
  opacity: number,
  blendMode: Layer['blendMode'],
): void {
  for (let d = 0; d < out.length; d += 4) {
    if (own[d + 3] === 0 || base[d + 3] === 0) continue;
    const clipAlpha = Math.round(own[d + 3] * opacity * (base[d + 3] / 255));
    const [r, g, b, a] = compositeOver(
      [own[d], own[d + 1], own[d + 2], clipAlpha],
      1,
      [out[d], out[d + 1], out[d + 2], out[d + 3]],
      blendMode,
    );
    out[d] = r;
    out[d + 1] = g;
    out[d + 2] = b;
    out[d + 3] = a;
  }
}

/**
 * Flatten one scope — the top-level list when `parentId` is `null`, or one
 * group's children otherwise (`model/layerTree.ts`). A group recurses into
 * this same function and the result is merged into the caller's buffer
 * exactly like a leaf layer's cel would be, which is what "a group composites
 * as one unit, using its own opacity/blend mode" means in practice.
 *
 * Clipping masks (`docs/08-roadmap.md` Phase 3) never cross a scope boundary:
 * `base` — the nearest non-clipping layer's own contribution — resets on
 * every recursive call.
 */
function flattenScope(
  sprite: Sprite,
  frameId: string,
  parentId: LayerId | null,
): Uint8ClampedArray {
  const { width, height } = sprite;
  const out = new Uint8ClampedArray(width * height * 4);
  let base: Uint8ClampedArray | null = null;

  for (const layer of childrenOf(sprite.layers, parentId)) {
    if (!layer.visible || layer.opacity === 0) continue;

    let own: Uint8ClampedArray | null;
    if (layer.kind === 'group') {
      own = flattenScope(sprite, frameId, layer.id);
    } else {
      const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
      if (!cel) {
        own = null;
      } else if (layer.kind === 'tilemap') {
        // A tilemap layer's cel holds grid data, not a pixel buffer — resolve
        // it against its tileset the same way `canvas/renderer.ts` does, so
        // export sees exactly what the canvas shows.
        const tileset = sprite.tilesets.find((t) => t.id === layer.tilesetId);
        const gridBuffer = getGrid(celBufferId(cel));
        own = placeCel(renderTilemapCel(tileset, layer.grid, gridBuffer, cel), cel, width, height);
      } else {
        const buf = getBuffer(celBufferId(cel));
        own = buf ? placeCel(buf, cel, width, height) : null;
      }
    }
    if (!own) continue;

    if (layer.clippingMask) {
      // No base in this scope to clip to — nothing below it, or everything
      // below it happened to be hidden. Contributes nothing, matching
      // Photoshop/Krita/Aseprite rather than falling back to unclipped.
      if (!base) continue;
      mergeClipped(out, own, base, layer.opacity, layer.blendMode);
    } else {
      mergeNormal(out, own, layer.opacity, layer.blendMode);
      base = ownContribution(own, layer.opacity);
    }
  }

  return out;
}

export function flattenSprite(sprite: Sprite, frameId: string): Uint8ClampedArray {
  return flattenScope(sprite, frameId, null);
}
