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

import type {
  Cel,
  CelId,
  Frame,
  FrameId,
  Layer,
  LayerId,
  Palette,
  Sprite,
  Tag,
  TagId,
  TileEntry,
  TileEntryId,
  Tileset,
  TilesetId,
} from '../model/types';

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
  swapLayers(a: LayerId, b: LayerId): void;
  updateLayer(id: LayerId, patch: Partial<Layer>): void;
  setActiveLayer(id: LayerId): void;
  celsForLayer(layerId: LayerId): Cel[];

  // ---- frame lifecycle (`docs/08-roadmap.md` Phase 4, "Frames, cels, linked
  // cels") — the same command-pattern vocabulary as the layer primitives
  // above, one level over on the other axis of the layer×frame grid.
  insertFrame(frame: Frame, cels: Cel[], index: number): void;
  removeFrameMetadata(id: FrameId): void;
  swapFrames(a: FrameId, b: FrameId): void;
  updateFrame(id: FrameId, patch: Partial<Frame>): void;
  setActiveFrame(id: FrameId): void;
  celsForFrame(frameId: FrameId): Cel[];
  /** Point one cel at another's buffer (`undefined` clears the link). */
  setCelLink(celId: CelId, linkedTo: CelId | undefined): void;

  // ---- tags (`docs/03-data-model.md` §2.3, roadmap Phase 4 "Tags with
  // preset names") ----
  insertTag(tag: Tag, index: number): void;
  removeTagMetadata(id: TagId): void;
  updateTag(id: TagId, patch: Partial<Tag>): void;

  // ---- tilesets & tilemap cels (`docs/03-data-model.md` §4, roadmap Phase 6)
  // ----
  insertTileset(tileset: Tileset, index: number): void;
  removeTilesetMetadata(id: TilesetId): void;
  insertTileEntry(tilesetId: TilesetId, entry: TileEntry, index: number): void;
  removeTileEntryMetadata(tilesetId: TilesetId, tileEntryId: TileEntryId): void;
  setTilemapCell(celId: CelId, col: number, row: number, tileId: number): void;

  // ---- indexed color mode (`docs/08-roadmap.md` Phase 7, `docs/10-decisions.md`
  // D9) ----
  /** Assign or recolor the sprite's own embedded palette — see `model/types.ts::Sprite.palette`. */
  setSpritePalette(palette: Palette): void;
  /**
   * Flip `Sprite.colorMode` (and, atomically, `Sprite.palette` — `undefined`
   * clears it). See `state/documentStore.ts::DocumentState.setColorMode` for
   * why this is a separate primitive from `setSpritePalette`.
   */
  setColorMode(mode: Sprite['colorMode'], palette?: Palette): void;
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
