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

import { getBuffer } from '../model/pixelBuffers';
import { childrenOf } from '../model/layerTree';
import type { BlendMode, Cel, LayerId, RGBA, Sprite } from '../model/types';
import { blendFunction } from './blend';

/**
 * Source-over compositing of straight-alpha colours, in 0..255 / 0..1.
 *
 * `blendMode` folds in via the W3C Compositing formula
 * `Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)`, then `Cs'` takes the place `Cs` occupied
 * in plain source-over — the alpha maths (`outA`, the mix weights) is
 * completely unchanged by blend mode, only the colour being mixed in is
 * (`blend.ts`). `'normal'` skips the extra work: `B(Cb, Cs) = Cs` there, which
 * makes `Cs' = Cs` identically, so this must stay behaviourally identical to
 * the pre-blend-mode function for every existing caller.
 */
export function compositeOver(
  src: RGBA,
  srcAlpha: number,
  dst: RGBA,
  blendMode: BlendMode = 'normal',
): RGBA {
  const sa = (src[3] / 255) * srcAlpha;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];

  let blended: readonly [number, number, number] = [src[0], src[1], src[2]];
  if (blendMode !== 'normal' && da > 0) {
    const backdrop: readonly [number, number, number] = [dst[0] / 255, dst[1] / 255, dst[2] / 255];
    const source: readonly [number, number, number] = [src[0] / 255, src[1] / 255, src[2] / 255];
    const b = blendFunction(blendMode, backdrop, source);
    blended = [
      ((1 - da) * source[0] + da * b[0]) * 255,
      ((1 - da) * source[1] + da * b[1]) * 255,
      ((1 - da) * source[2] + da * b[2]) * 255,
    ];
  }

  const mix = (s: number, d: number) => (s * sa + d * da * (1 - sa)) / outA;
  return [
    Math.round(mix(blended[0], dst[0])),
    Math.round(mix(blended[1], dst[1])),
    Math.round(mix(blended[2], dst[2])),
    Math.round(outA * 255),
  ];
}

/** The layer's own pixel at one document coordinate, or `null` outside its cel. */
function sampleCel(cel: Cel, x: number, y: number): RGBA | null {
  const lx = x - cel.x;
  const ly = y - cel.y;
  if (lx < 0 || ly < 0 || lx >= cel.width || ly >= cel.height) return null;

  const buf = getBuffer(cel.id);
  if (!buf) return null;

  const i = (ly * cel.width + lx) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
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

    const own: RGBA | null =
      layer.kind === 'group'
        ? compositeScopePixel(sprite, frameId, layer.id, x, y)
        : (() => {
            const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
            return cel ? sampleCel(cel, x, y) : null;
          })();
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
