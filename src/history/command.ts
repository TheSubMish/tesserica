/**
 * The command pattern behind undo/redo (`docs/03-data-model.md` §6).
 *
 * Snapshots of the whole document would be ~300 MB for a 20-step history on a
 * modest animated sprite, so commands store *inverse patches* instead: a
 * pencil stroke keeps the bounding box of the pixels it touched plus the
 * before/after bytes for that box, and nothing else.
 *
 * `apply`/`invert` receive the document API rather than a plain `Document`
 * value: our document lives in a zustand store with the pixel buffers held
 * outside React (`docs/02-architecture.md` §4), so "the document" is a handle,
 * not an object graph to mutate in place.
 */

import type { Cel, CelId, Layer, LayerId, Sprite } from '../model/types';

/**
 * The slice of `documentStore` that commands are allowed to touch. Keeping it
 * explicit stops commands from reaching into UI state and makes them testable
 * against a fake.
 */
export interface DocumentApi {
  sprite: Sprite;
  activeLayerId: LayerId;
  activeFrameId: string;
  /** Signal that pixel data changed so the canvas redraws. */
  touch(celId?: CelId): void;

  insertLayer(layer: Layer, cels: Cel[], index: number): void;
  removeLayerMetadata(id: LayerId): void;
  moveLayer(id: LayerId, toIndex: number): void;
  updateLayer(id: LayerId, patch: Partial<Layer>): void;
  setActiveLayer(id: LayerId): void;
  celsForLayer(layerId: LayerId): Cel[];
}

export interface Command {
  /** Shown in the UI: "Pencil", "Add Layer". */
  label: string;
  apply(doc: DocumentApi): void;
  invert(doc: DocumentApi): void;
  /**
   * Merge a following command into this one, or return `null` to refuse.
   * This is what makes one slider drag a single undo step.
   */
  coalesceWith?(next: Command): Command | null;
  /** Approximate retained bytes, for the history budget. */
  memoryCost: number;
}
