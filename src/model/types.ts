/**
 * Core document types — a Phase 0 subset of `docs/03-data-model.md`.
 *
 * The full model (frames, tags, slices, tilemap/conversion layers, indexed
 * cels) is specified there and lands in later phases. What exists here is
 * deliberately the smallest shape that will not need reworking: the
 * layer × frame → cel structure is present from the start, even though Phase 0
 * only ever has one frame.
 *
 * D9: v1 is RGBA only. The `indexed` cel variant stays out of the union until
 * Phase 7 so nothing accidentally depends on it.
 */

import type { ConvertSettings } from '../pipeline/settings.ts';

export type LayerId = string;
export type FrameId = string;
export type CelId = string;

export type RGBA = readonly [r: number, g: number, b: number, a: number];

/**
 * `docs/03-data-model.md` §2.1 — the full W3C Compositing/Blending set.
 *
 * Composited in `canvas/blend.ts` (the maths) and folded into alpha
 * compositing in `canvas/sample.ts::compositeOver` (the "straight alpha, never
 * premultiplied" invariant applies to blended colours exactly as it does to
 * plain source-over ones).
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface LayerBase {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /**
   * `docs/03-data-model.md` §2.1 — groups nest via this pointer into the same
   * flat `Sprite.layers` array rather than a separate tree structure. A
   * layer's siblings are every other layer sharing its `parentId`; their
   * relative order is whatever order they appear in the flat array, which
   * need not be contiguous with each other or with the parent (see
   * `model/layerTree.ts`).
   */
  parentId: LayerId | null;
  /**
   * "Clip to layer below" (Photoshop/Krita/Aseprite convention): a `true`
   * layer is masked by the *own* alpha of the nearest non-clipping layer
   * below it, scoped to its own parent/group — never across a group boundary.
   * See `canvas/layerTree.ts`.
   */
  clippingMask: boolean;
  // `effects` (docs/03-data-model.md §5) is Phase 7 — deliberately omitted
  // rather than added unused.
}

/**
 * What makes convert→edit continuous (`docs/03-data-model.md` §2.1).
 *
 * The layer keeps a handle to the full-resolution image Rust still holds, plus
 * the settings that produced its pixels — so changing the palette weeks later
 * re-renders it, rather than requiring the user to start again from the photo.
 */
export interface ConversionSource {
  /** Handle to the full-res image held in Rust (`docs/02` §6.2). */
  sourceId: number;
  settings: ConvertSettings;
}

/**
 * `docs/03-data-model.md` §2.1.
 *
 * Tilemap arrives with its phase (6); `conversion` is here because it is the
 * product thesis — a conversion is a live, re-editable layer inside a real
 * editor rather than a PNG dump. `group` has no pixels of its own: its
 * members are every other layer whose `parentId` points at it, and it
 * composites as a unit (`canvas/layerTree.ts`).
 */
export type Layer =
  | (LayerBase & { kind: 'raster' })
  | (LayerBase & { kind: 'group'; collapsed: boolean })
  | (LayerBase & { kind: 'conversion'; source: ConversionSource });

export interface Frame {
  id: FrameId;
  durationMs: number;
}

/**
 * A cel is the content of one layer at one frame.
 *
 * Cels are bounded (x/y/width/height may be smaller than the sprite) in the
 * full model. Phase 0 always allocates them sprite-sized; the fields exist so
 * that bounding them later is not a schema change.
 *
 * **Linked cels** (`docs/03-data-model.md` §2.2): when `linkedTo` is set, this
 * cel has no pixel buffer of its own in `model/pixelBuffers.ts` — it shares
 * the buffer of the cel `linkedTo` points at, always another cel on the same
 * `layerId` at a different `frameId`. Painting on either frame therefore
 * edits the same bytes and both are updated, which is what makes "this layer
 * doesn't change on these frames" cost one buffer instead of N. A link never
 * chains: `linkedTo` always names a cel that is itself unlinked (the
 * "canonical" cel), so resolving a buffer id never needs to follow more than
 * one hop — see `celBufferId`.
 */
export interface Cel {
  id: CelId;
  layerId: LayerId;
  frameId: FrameId;
  x: number;
  y: number;
  width: number;
  height: number;
  linkedTo?: CelId;
}

/**
 * The id under which a cel's pixels actually live in `model/pixelBuffers.ts`.
 *
 * Every reader of a cel's pixels — the renderer, the eyedropper, export,
 * drawing tools — must resolve through this rather than using `cel.id`
 * directly, or a linked cel would look blank instead of sharing its target's
 * content.
 */
export function celBufferId(cel: Pick<Cel, 'id' | 'linkedTo'>): CelId {
  return cel.linkedTo ?? cel.id;
}

/**
 * `docs/03-data-model.md` §3.
 *
 * D9: v1 is RGBA only, so a palette is a *swatch list* — nothing indexes into
 * it. Indexed mode and live palette swapping are Phase 7.
 */
export interface Palette {
  id: string;
  name: string;
  colors: RGBA[];
  source?: { kind: 'builtin' | 'lospec' | 'file' | 'custom'; ref?: string };
}

export interface Sprite {
  width: number;
  height: number;
  layers: Layer[]; // bottom → top
  frames: Frame[];
  cels: Cel[];
}

export const celKey = (layerId: LayerId, frameId: FrameId): string => `${layerId}:${frameId}`;
