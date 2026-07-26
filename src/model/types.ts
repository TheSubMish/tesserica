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

export type LayerId = string;
export type FrameId = string;
export type CelId = string;

export type RGBA = readonly [r: number, g: number, b: number, a: number];

export type BlendMode = 'normal';

export interface LayerBase {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
}

/** Phase 0 has raster layers only. Group/tilemap/conversion arrive later. */
export type Layer = LayerBase & { kind: 'raster' };

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
 */
export interface Cel {
  id: CelId;
  layerId: LayerId;
  frameId: FrameId;
  x: number;
  y: number;
  width: number;
  height: number;
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
