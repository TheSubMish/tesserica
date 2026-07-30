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

export type TilesetId = string;
export type TileEntryId = string;

/**
 * `docs/03-data-model.md` §4.
 *
 * One entry in a `Tileset`'s tile list. The doc's own sketch does not specify
 * what a `TileEntry` holds beyond "index 0 is always the empty tile" — this
 * is the smallest reasonable shape consistent with `docs/02-architecture.md`
 * §4's "pixel data stays out of React state": `TileEntry` is metadata only
 * (an id), and its actual RGBA pixels live in `model/tileBuffers.ts`, addressed
 * by that id, exactly the way `Cel` holds no pixels itself and
 * `model/pixelBuffers.ts` does. Index 0's id still resolves to a real,
 * fully-transparent buffer (`tileWidth`×`tileHeight`), so "the empty tile" is
 * a real, drawable (no-op) tile rather than a special-cased absence.
 */
export interface TileEntry {
  id: TileEntryId;
}

/**
 * `docs/03-data-model.md` §4. A reusable set of tile images shared by one or
 * more tilemap layers.
 */
export interface Tileset {
  id: TilesetId;
  name: string;
  tileWidth: number;
  tileHeight: number;
  /** Index 0 is always the empty tile — see `model/tilesets.ts::createTileset`. */
  tiles: TileEntry[];
}

/**
 * `docs/03-data-model.md` §4 — v1 ships `rect` only. `isometric`/`hexagonal`
 * are in the type from day one (D9-style extension, not migration) but
 * nothing renders or edits them (roadmap Phase 6, Phase 7 "Isometric and
 * hexagonal tile grids").
 */
export type GridShape = 'rect' | 'isometric' | 'hexagonal';

export interface GridSpec {
  shape: GridShape;
  tileWidth: number;
  tileHeight: number;
  offsetX: number;
  offsetY: number;
}

/**
 * `docs/03-data-model.md` §2.1.
 *
 * Tilemap arrives with its phase (6); `conversion` is here because it is the
 * product thesis — a conversion is a live, re-editable layer inside a real
 * editor rather than a PNG dump. `group` has no pixels of its own: its
 * members are every other layer whose `parentId` points at it, and it
 * composites as a unit (`canvas/layerTree.ts`).
 *
 * A `tilemap` layer's cels (one per frame, exactly like `raster`) hold no
 * pixel buffer in `model/pixelBuffers.ts` — instead, each cel's *grid*
 * content (which tile sits in which cell, `model/tileGridBuffers.ts`) is
 * resolved against this layer's `tileset`/`grid` at composite time
 * (`model/tilemapRender.ts`), the same "different buffer, same `Cel`
 * shape" divergence `conversion` already established for re-rendered pixels.
 */
export type Layer =
  | (LayerBase & { kind: 'raster' })
  | (LayerBase & { kind: 'group'; collapsed: boolean })
  | (LayerBase & { kind: 'tilemap'; tilesetId: TilesetId; grid: GridSpec })
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

/**
 * `docs/03-data-model.md` §2.3 — a named, inclusive range of frame *indices*
 * (not frame ids: Aseprite's own convention, and what lets a tag survive a
 * frame being duplicated or reordered elsewhere in the timeline without a
 * dangling reference). "Preset tag names" (idle/walk/run/attack/hurt/death)
 * are offered by the UI on creation, not enforced here — `name` is a plain
 * string so a custom name is exactly as valid as a preset one.
 *
 * **Implementation note.** `03-data-model.md`'s sketch of `Tag` has no `id`
 * field, only `name` — but every other collection in this model (`Layer`,
 * `Frame`, `Cel`) is addressed by a stable id rather than by name, which is
 * what makes rename-in-place and undo/redo unambiguous even when two tags
 * share a name (a base tag plus a hand-copied variant, say). Added `id` here
 * for the same reason, mirroring the `LayerId`/`FrameId`/`CelId` convention;
 * the wire format gains one extra field, camelCase either way, so no
 * translation layer is needed on the Rust side either.
 */
export type TagId = string;

export type TagDirection = 'forward' | 'reverse' | 'pingpong';

export interface Tag {
  id: TagId;
  name: string;
  /** Frame indices, inclusive. `from <= to` always holds. */
  from: number;
  to: number;
  direction: TagDirection;
  repeat?: number;
  /** CSS color string for the tag's chip in the Timeline panel. */
  color: string;
}

export interface Sprite {
  width: number;
  height: number;
  layers: Layer[]; // bottom → top
  frames: Frame[];
  cels: Cel[];
  tags: Tag[];
  /** `docs/03-data-model.md` §4, roadmap Phase 6. Empty until a tileset exists. */
  tilesets: Tileset[];
}

export const celKey = (layerId: LayerId, frameId: FrameId): string => `${layerId}:${frameId}`;
