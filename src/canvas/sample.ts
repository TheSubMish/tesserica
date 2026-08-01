/**
 * Read the composited colour at one document pixel.
 *
 * The eyedropper picks what the user can *see*, which is the flattened stack,
 * not the active layer. Doing that by reading back from the display canvas
 * would sample post-zoom screen pixels and, on a HiDPI display, the wrong
 * ones; compositing the single pixel arithmetically avoids the whole class of
 * bug and needs no canvas at all.
 *
 * Straight ("unassociated") alpha throughout — never premultiplied
 * (`docs/02-architecture.md` §9).
 */

import { getCelBuffer, isIndexedLayer } from '../model/celStorage';
import { resolveIndexToRgba } from '../model/indexedColor';
import { getGrid } from '../model/tileGridBuffers';
import { renderTilemapCel } from '../model/tilemapRender';
import { childrenOf } from '../model/layerTree';
import {
  celBufferId,
  type Cel,
  type Layer,
  type LayerId,
  type RGBA,
  type Sprite,
} from '../model/types';
import { applyEffects, hasEnabledEffects } from './effects';

export { compositeOver } from './compositeOver';
import { compositeOver } from './compositeOver';

/**
 * The layer's own pixel at one document coordinate, or `null` outside its cel.
 *
 * For an indexed-mode raster layer (`docs/08-roadmap.md` Phase 7,
 * `model/celStorage.ts`), resolves the one stored index through the sprite's
 * palette rather than materializing the whole cel — the eyedropper samples a
 * single pixel per click, so there is no reason to pay `renderIndexedCel`'s
 * whole-cel cost here.
 */
function sampleCel(
  sprite: Sprite,
  layer: Exclude<Layer, { kind: 'group' }>,
  cel: Cel,
  x: number,
  y: number,
): RGBA | null {
  const lx = x - cel.x;
  const ly = y - cel.y;
  if (lx < 0 || ly < 0 || lx >= cel.width || ly >= cel.height) return null;

  const buf = getCelBuffer(sprite, layer, celBufferId(cel));
  if (!buf) return null;

  if (isIndexedLayer(sprite, layer)) {
    const idx = (buf as Uint8Array)[ly * cel.width + lx];
    return sprite.palette ? resolveIndexToRgba(idx, sprite.palette) : [0, 0, 0, 0];
  }

  const i = (ly * cel.width + lx) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/**
 * A tilemap layer's resolved colour at one document coordinate — the
 * eyedropper's equivalent of `sampleCel` above. Delegates the whole cel to
 * `renderTilemapCel` (`canvas/renderer.ts::tilemapCelCanvas` and
 * `canvas/flatten.ts` call the very same function) rather than re-deriving
 * placement math here a third time — correct by construction for every
 * `GridShape`, including `isometric`/`hexagonal`, where a pixel can fall
 * inside more than one tile's overlapping bounding box and the *rendered*
 * (alpha-composited, back-to-front) result is the only correct source of
 * truth for "what's actually visible here". Not a hot path — the eyedropper
 * samples one pixel per click, never in a loop; `leafOwnBuffer` below
 * special-cases the one genuine loop (an effect-bearing tilemap layer) to
 * render the cel once rather than once per pixel.
 */
function sampleTilemapCel(
  sprite: Sprite,
  layer: Layer & { kind: 'tilemap' },
  cel: Cel,
  x: number,
  y: number,
): RGBA | null {
  const lx = x - cel.x;
  const ly = y - cel.y;
  if (lx < 0 || ly < 0 || lx >= cel.width || ly >= cel.height) return null;

  const tileset = sprite.tilesets.find((t) => t.id === layer.tilesetId);
  const gridBuffer = getGrid(celBufferId(cel));
  const rendered = renderTilemapCel(tileset, layer.grid, gridBuffer, cel);
  const i = (ly * cel.width + lx) * 4;
  return [rendered[i], rendered[i + 1], rendered[i + 2], rendered[i + 3]];
}

/**
 * A leaf layer's own content, materialized over the *whole* sprite rather
 * than one pixel — needed only when the layer has an enabled effect
 * (`canvas/effects.ts`), since outline/drop-shadow are neighbourhood-
 * dependent and cannot be answered from a single coordinate in isolation.
 * Cheap enough to recompute per query for a raster/conversion layer: the
 * eyedropper samples one pixel per click, never in a loop (`CanvasView.tsx`),
 * so this is not a hot path the way `renderer.ts`'s per-redraw compositing
 * is. A tilemap layer is the one genuine loop here (every sprite pixel, not
 * one) — `sampleTilemapCel` now renders its whole cel per call
 * (`renderTilemapCel`, correct for overlapping `isometric`/`hexagonal`
 * bounding boxes), so this renders that cel exactly once up front and reads
 * pixels back out of it directly rather than calling `sampleTilemapCel`
 * `width * height` times.
 */
function leafOwnBuffer(
  sprite: Sprite,
  layer: Layer & { kind: 'raster' | 'tilemap' | 'conversion' },
  cel: Cel,
): Uint8ClampedArray {
  const { width, height } = sprite;
  const out = new Uint8ClampedArray(width * height * 4);

  if (layer.kind === 'tilemap') {
    const tileset = sprite.tilesets.find((t) => t.id === layer.tilesetId);
    const gridBuffer = getGrid(celBufferId(cel));
    const rendered = renderTilemapCel(tileset, layer.grid, gridBuffer, cel);
    for (let y = 0; y < height; y++) {
      const ly = y - cel.y;
      if (ly < 0 || ly >= cel.height) continue;
      for (let x = 0; x < width; x++) {
        const lx = x - cel.x;
        if (lx < 0 || lx >= cel.width) continue;
        const s = (ly * cel.width + lx) * 4;
        const d = (y * width + x) * 4;
        out[d] = rendered[s];
        out[d + 1] = rendered[s + 1];
        out[d + 2] = rendered[s + 2];
        out[d + 3] = rendered[s + 3];
      }
    }
    return out;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = sampleCel(sprite, layer, cel, x, y);
      if (!rgba) continue;
      const i = (y * width + x) * 4;
      out[i] = rgba[0];
      out[i + 1] = rgba[1];
      out[i + 2] = rgba[2];
      out[i + 3] = rgba[3];
    }
  }
  return out;
}

/**
 * A group's own content, materialized over the whole sprite — the group
 * counterpart to {@link leafOwnBuffer}, reusing `compositeScopePixel` itself
 * (recursively, one call per pixel) so a nested layer's own effects are
 * already folded in by the time this buffer is built.
 */
function groupOwnBuffer(sprite: Sprite, frameId: string, groupId: LayerId): Uint8ClampedArray {
  const { width, height } = sprite;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = compositeScopePixel(sprite, frameId, groupId, x, y);
      const i = (y * width + x) * 4;
      out[i] = rgba[0];
      out[i + 1] = rgba[1];
      out[i + 2] = rgba[2];
      out[i + 3] = rgba[3];
    }
  }
  return out;
}

/**
 * One layer's own contribution at one document coordinate, effects included
 * (`docs/03-data-model.md` §5) — what the eyedropper must agree with, since it
 * reports what is actually visible, not the pre-effect pixel.
 */
function ownContributionAt(
  sprite: Sprite,
  frameId: string,
  layer: Layer,
  x: number,
  y: number,
): RGBA | null {
  if (!hasEnabledEffects(layer.effects)) {
    if (layer.kind === 'group') return compositeScopePixel(sprite, frameId, layer.id, x, y);
    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    if (!cel) return null;
    return layer.kind === 'tilemap'
      ? sampleTilemapCel(sprite, layer, cel, x, y)
      : sampleCel(sprite, layer, cel, x, y);
  }

  let buffer: Uint8ClampedArray;
  if (layer.kind === 'group') {
    buffer = groupOwnBuffer(sprite, frameId, layer.id);
  } else {
    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    if (!cel) return null;
    buffer = leafOwnBuffer(sprite, layer, cel);
  }
  const applied = applyEffects(buffer, sprite.width, sprite.height, layer.effects);
  const i = (y * sprite.width + x) * 4;
  return [applied[i], applied[i + 1], applied[i + 2], applied[i + 3]];
}

/**
 * Composite one document pixel through one scope — the top-level stack when
 * `parentId` is `null`, or one group's children otherwise
 * (`model/layerTree.ts`). A group recurses into this same function and its
 * result is folded back in as if it were an ordinary layer, which is what
 * makes "a group composites as one unit" true without a separate code path.
 *
 * Clipping masks (`docs/08-roadmap.md` Phase 3, "clip to layer below") never
 * cross a scope boundary: `base` tracks only the nearest non-clipping layer
 * *within this call*, reset to `null` on every recursive entry.
 */
function compositeScopePixel(
  sprite: Sprite,
  frameId: string,
  parentId: LayerId | null,
  x: number,
  y: number,
): RGBA {
  let out: RGBA = [0, 0, 0, 0];
  /** The nearest non-clipping layer's own contribution, alpha already scaled
   * by its opacity — what a clipping layer above it is masked by. */
  let base: RGBA | null = null;

  for (const layer of childrenOf(sprite.layers, parentId)) {
    if (!layer.visible || layer.opacity === 0) continue;

    const own = ownContributionAt(sprite, frameId, layer, x, y);
    if (!own) continue;

    if (layer.clippingMask) {
      // Nothing below to clip to in this scope — Photoshop/Krita/Aseprite all
      // treat this as contributing nothing, not as an unclipped layer.
      if (!base) continue;
      const ownAlpha = (own[3] / 255) * layer.opacity;
      const clipAlpha = Math.round(ownAlpha * (base[3] / 255) * 255);
      out = compositeOver([own[0], own[1], own[2], clipAlpha], 1, out, layer.blendMode);
    } else {
      out = compositeOver(own, layer.opacity, out, layer.blendMode);
      base = [own[0], own[1], own[2], Math.round((own[3] / 255) * layer.opacity * 255)];
    }
  }
  return out;
}

export function samplePixel(sprite: Sprite, frameId: string, x: number, y: number): RGBA | null {
  if (x < 0 || y < 0 || x >= sprite.width || y >= sprite.height) return null;
  return compositeScopePixel(sprite, frameId, null, x, y);
}
