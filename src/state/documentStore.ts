/**
 * Document state. Metadata only — pixels live in `model/pixelBuffers.ts`.
 *
 * `revision` is bumped whenever pixel data changes so the renderer knows to
 * redraw without the pixels themselves ever entering React state.
 *
 * Everything here is a **primitive**: it mutates the document and records
 * nothing. Undoable layer operations are composed from these in
 * `history/layerCommands.ts`. Keeping the split means a command's `apply` and
 * `invert` are built from the same vocabulary, and ids stay stable across
 * undo→redo because the command supplies them rather than the store minting
 * fresh ones on every replay.
 */

import { create } from 'zustand';
import type {
  Cel,
  CelId,
  ConversionSource,
  Frame,
  FrameId,
  GridSpec,
  Layer,
  LayerBase,
  LayerId,
  Sprite,
  Tag,
  TagId,
  TileEntry,
  TileEntryId,
  Tileset,
  TilesetId,
} from '../model/types';
import { descendantIds } from '../model/layerTree';
import { shiftTagRangeForInsert, shiftTagRangeForRemove } from '../model/tags';
import { celBufferId } from '../model/types';
import { tileGridDims } from '../model/tileIds';
import {
  allocateBuffer,
  bumpCelRevision,
  clearAllBuffers,
  getBuffer,
  releaseBuffer,
  setBuffer,
} from '../model/pixelBuffers';
import {
  allocateGrid,
  bumpGridRevision,
  clearAllGrids,
  getGrid,
  setGrid,
  setGridCell,
} from '../model/tileGridBuffers';
import { allocateEmptyTileBuffer, clearAllTileBuffers, setTileBuffer } from '../model/tileBuffers';

let nextId = 1;
export const makeId = (prefix: string): string => `${prefix}${nextId++}`;

/**
 * Push the id counter past every id in `existing`.
 *
 * Ids in a loaded `.tess` were minted by another run of the generator, so a
 * freshly opened document would otherwise start handing out ids that collide
 * with the ones it just read — and a colliding cel id means two layers sharing
 * a pixel buffer.
 */
export function reserveIds(existing: string[]): void {
  for (const id of existing) {
    const n = Number(/^[a-z]+(\d+)$/.exec(id)?.[1]);
    if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
  }
}

interface DocumentState {
  sprite: Sprite;
  activeLayerId: LayerId;
  activeFrameId: string;
  /** Bumped on every pixel mutation; the canvas redraws when it changes. */
  revision: number;
  /** Where this document was opened from / last saved to, if anywhere. */
  projectPath: string | null;

  setProjectPath(path: string | null): void;
  /**
   * Replace the whole document, e.g. after opening a `.tess`.
   *
   * `grids`/`tileBuffers` are optional — every caller before Phase 6 (and
   * every document with no tilemap layers) has nothing to pass for either.
   */
  replaceDocument(
    sprite: Sprite,
    pixels: Map<CelId, Uint8ClampedArray>,
    grids?: Map<CelId, Uint32Array>,
    tileBuffers?: Map<TileEntryId, Uint8ClampedArray>,
  ): void;
  /**
   * Start a fresh document — `Ctrl+N` (`docs/06-workflows.md` W2 step 1).
   *
   * One raster layer, one frame, blank. Routed through `replaceDocument` so it
   * gets the same buffer-release and id-reservation guarantees as opening a
   * `.tess`, rather than a second copy of that bookkeeping.
   */
  newDocument(width: number, height: number): void;

  /**
   * Signal a change. Passing the cel that changed lets the renderer re-upload
   * only that layer; omitting it invalidates the whole composite.
   */
  touch(celId?: CelId): void;

  // ---- primitives ----
  /** Build a detached raster layer plus one cel per frame. */
  createLayer(name?: string, parentId?: LayerId | null): { layer: Layer; cels: Cel[] };
  /**
   * Build a detached group layer. Groups hold no pixels of their own — their
   * "contents" are just every other layer whose `parentId` points at them
   * (`model/layerTree.ts`) — so there are no cels to allocate.
   */
  createGroup(name?: string, parentId?: LayerId | null): { layer: Layer; cels: Cel[] };
  /**
   * Build a detached tilemap layer plus one (empty-grid) cel per frame —
   * `createLayer`'s mirror one variant over (`docs/03-data-model.md` §4,
   * roadmap Phase 6). `tilesetId` must already exist in `sprite.tilesets`;
   * callers are expected to check (`history/tilesetCommands.ts::addTilemapLayer`).
   */
  createTilemapLayer(
    tilesetId: TilesetId,
    grid: GridSpec,
    name?: string,
    parentId?: LayerId | null,
  ): { layer: Layer; cels: Cel[] };
  /** Insert a layer at `index` in the bottom→top order. */
  insertLayer(layer: Layer, cels: Cel[], index: number): void;
  /**
   * Drop a layer's metadata and cels. Buffers are **not** released — the
   * caller owns them, which is what lets a delete command hand them back.
   */
  removeLayerMetadata(id: LayerId): void;
  /**
   * Exchange the stack position of two layers. Reordering is expressed as a
   * swap rather than a splice-to-index so that moving a layer only ever
   * disturbs the one sibling it trades places with — everything else's
   * relative order, including layers that live in a different group, is
   * untouched (`model/layerTree.ts`).
   */
  swapLayers(a: LayerId, b: LayerId): void;
  /**
   * Patch a layer's metadata.
   *
   * `Partial<LayerBase>` rather than `Partial<Layer>`: `Layer` is a
   * discriminated union, and spreading a partial of a union would let a caller
   * change `kind` without supplying the fields that variant requires. Kind is
   * decided at creation.
   */
  updateLayer(id: LayerId, patch: Partial<LayerBase>): void;

  /**
   * Replace a conversion layer's source and settings.
   *
   * Separate from `updateLayer` because it is the one patch that is *not*
   * metadata: it is the layer's re-render recipe, and it only exists on the
   * `conversion` variant.
   */
  updateLayerSource(id: LayerId, source: ConversionSource): void;
  /**
   * Collapse/expand a group in the layer panel. Kept separate from
   * `updateLayer` for the same reason `updateLayerSource` is: `collapsed`
   * only exists on the `group` variant, and this is not something an undo
   * step needs to remember (view state, not document content).
   */
  setGroupCollapsed(id: LayerId, collapsed: boolean): void;
  setActiveLayer(id: LayerId): void;
  layerIndex(id: LayerId): number;

  // ---- convenience (not undoable; used by tests and bootstrap) ----
  addLayer(name?: string): void;
  removeLayer(id: LayerId): void;
  toggleLayerVisibility(id: LayerId): void;

  activeCel(): Cel | undefined;
  celFor(layerId: LayerId, frameId: string): Cel | undefined;
  celsForLayer(layerId: LayerId): Cel[];

  // ---- frames & cels (`docs/03-data-model.md` §2.2, roadmap Phase 4) ----
  // Mirrors the layer primitives above one axis over: a `Frame` is the other
  // half of the layer×frame grid a `Cel` sits at the intersection of.
  /** Build a detached frame plus one blank cel per non-group layer. */
  createFrame(durationMs?: number): { frame: Frame; cels: Cel[] };
  /** Insert a frame at `index` in time order. */
  insertFrame(frame: Frame, cels: Cel[], index: number): void;
  /**
   * Drop a frame's metadata and its cels. Buffers are **not** released —
   * mirrors `removeLayerMetadata`, so the caller decides what survives (a
   * still-linked cel elsewhere must keep its shared buffer alive).
   */
  removeFrameMetadata(id: FrameId): void;
  /** Exchange the time-order position of two frames. */
  swapFrames(a: FrameId, b: FrameId): void;
  /** Patch a frame's metadata (currently just `durationMs`). */
  updateFrame(id: FrameId, patch: Partial<Frame>): void;
  setActiveFrame(id: FrameId): void;
  frameIndex(id: FrameId): number;
  celsForFrame(frameId: FrameId): Cel[];
  /**
   * Point one cel at another's buffer, or clear the link when `linkedTo` is
   * `undefined`. A pure metadata patch — callers own the buffer bookkeeping
   * that makes a link or an unlink actually correct (`history/frameCommands.ts`).
   */
  setCelLink(celId: CelId, linkedTo: CelId | undefined): void;

  // ---- tags (`docs/03-data-model.md` §2.3, roadmap Phase 4 "Tags with
  // preset names") — no pixel buffers involved, so these primitives are
  // simpler than the layer/frame ones above: a tag is pure metadata.
  /** Insert a tag at `index` in creation order. */
  insertTag(tag: Tag, index: number): void;
  /** Drop a tag. There is nothing else referencing it, so this is final. */
  removeTagMetadata(id: TagId): void;
  /** Patch a tag's metadata (name, range, direction, repeat, color). */
  updateTag(id: TagId, patch: Partial<Tag>): void;
  tagIndex(id: TagId): number;

  // ---- tilesets & tilemap cels (`docs/03-data-model.md` §4, roadmap Phase 6)
  // ----
  /** Insert a tileset at `index` in creation order. */
  insertTileset(tileset: Tileset, index: number): void;
  /** Drop a tileset. Its tile buffers are **not** released — mirrors the
   * layer/frame convention, so undoing the removal restores identical pixels. */
  removeTilesetMetadata(id: TilesetId): void;
  tilesetIndex(id: TilesetId): number;
  /** Append (or re-insert, on undo) one tile entry into an existing tileset. */
  insertTileEntry(tilesetId: TilesetId, entry: TileEntry, index: number): void;
  removeTileEntryMetadata(tilesetId: TilesetId, tileEntryId: TileEntryId): void;
  /**
   * Paint one grid cell of a tilemap cel with a packed tile id
   * (`model/tileIds.ts`). A pure mutation of the cel's grid buffer, mirroring
   * `setCelLink`'s "callers own the undo bookkeeping" shape
   * (`history/tilesetCommands.ts::SetTileCellCommand`).
   */
  setTilemapCell(celId: CelId, col: number, row: number, tileId: number): void;
}

function createInitialSprite(
  width: number,
  height: number,
): {
  sprite: Sprite;
  activeLayerId: LayerId;
  activeFrameId: string;
} {
  const frame: Frame = { id: makeId('f'), durationMs: 100 };
  const layer: Layer = {
    id: makeId('l'),
    kind: 'raster',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId: null,
    clippingMask: false,
  };
  const cel: Cel = {
    id: makeId('c'),
    layerId: layer.id,
    frameId: frame.id,
    x: 0,
    y: 0,
    width,
    height,
  };
  allocateBuffer(cel.id, width, height);

  return {
    sprite: {
      width,
      height,
      layers: [layer],
      frames: [frame],
      cels: [cel],
      tags: [],
      tilesets: [],
    },
    activeLayerId: layer.id,
    activeFrameId: frame.id,
  };
}

const initial = createInitialSprite(64, 64);

export const useDocumentStore = create<DocumentState>((set, get) => ({
  sprite: initial.sprite,
  activeLayerId: initial.activeLayerId,
  activeFrameId: initial.activeFrameId,
  revision: 0,
  projectPath: null,

  setProjectPath: (path) => set({ projectPath: path }),

  replaceDocument: (sprite, pixels, grids = new Map(), tileBuffers = new Map()) => {
    // The old document's buffers are unreachable the moment the sprite is
    // swapped, so drop them rather than leaking them for the process lifetime.
    clearAllBuffers();
    clearAllGrids();
    clearAllTileBuffers();
    const tilesets = sprite.tilesets ?? [];
    reserveIds([
      ...sprite.layers.map((l) => l.id),
      ...sprite.frames.map((f) => f.id),
      ...sprite.cels.map((c) => c.id),
      ...tilesets.flatMap((t) => [t.id, ...t.tiles.map((e) => e.id)]),
    ]);

    for (const tileset of tilesets) {
      for (const entry of tileset.tiles) {
        const buf = tileBuffers.get(entry.id);
        const expected = tileset.tileWidth * tileset.tileHeight * 4;
        if (buf && buf.length === expected) setTileBuffer(entry.id, buf);
        else allocateEmptyTileBuffer(entry.id, tileset.tileWidth, tileset.tileHeight);
      }
    }

    for (const cel of sprite.cels) {
      // A linked cel has no buffer of its own — it shares `linkedTo`'s, which
      // this same loop populates from its own entry. Allocating one here
      // would give it independent (blank) pixels, breaking the link on load.
      if (cel.linkedTo) continue;
      const layer = sprite.layers.find((l) => l.id === cel.layerId);
      if (layer?.kind === 'tilemap') {
        const { cols, rows } = tileGridDims(cel, layer.grid);
        const g = grids.get(cel.id);
        if (g && g.length === cols * rows) setGrid(cel.id, g);
        else allocateGrid(cel.id, cols, rows);
        continue;
      }
      const buf = pixels.get(cel.id);
      if (buf && buf.length === cel.width * cel.height * 4) setBuffer(cel.id, buf);
      else allocateBuffer(cel.id, cel.width, cel.height);
    }

    set((s) => ({
      // `tags`/`tilesets` postdate this shape — a `.tess` saved before either
      // existed has no such field on the wire, and readers downstream (the
      // Timeline panel, the tileset panel) expect an array, not `undefined`
      // (mirrors the Rust side's `#[serde(default)]`).
      sprite: { ...sprite, tags: sprite.tags ?? [], tilesets },
      activeLayerId: sprite.layers[sprite.layers.length - 1]?.id ?? s.activeLayerId,
      activeFrameId: sprite.frames[0]?.id ?? s.activeFrameId,
      revision: s.revision + 1,
    }));
  },

  newDocument: (width, height) => {
    const frame: Frame = { id: makeId('f'), durationMs: 100 };
    const layer: Layer = {
      id: makeId('l'),
      kind: 'raster',
      name: 'Layer 1',
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      parentId: null,
      clippingMask: false,
    };
    const cel: Cel = {
      id: makeId('c'),
      layerId: layer.id,
      frameId: frame.id,
      x: 0,
      y: 0,
      width,
      height,
    };
    const sprite: Sprite = {
      width,
      height,
      layers: [layer],
      frames: [frame],
      cels: [cel],
      tags: [],
      tilesets: [],
    };
    get().replaceDocument(sprite, new Map());
  },

  touch: (celId) => {
    if (celId) bumpCelRevision(celId);
    set((s) => ({ revision: s.revision + 1 }));
  },

  createLayer: (name, parentId = null) => {
    const s = get();
    const layer: Layer = {
      id: makeId('l'),
      kind: 'raster',
      name: name ?? `Layer ${s.sprite.layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      parentId,
      clippingMask: false,
    };
    // One cel per frame. Phase 1 has a single frame, but writing it as a map
    // over frames means adding frames in Phase 4 needs no change here.
    const cels: Cel[] = s.sprite.frames.map((f) => ({
      id: makeId('c'),
      layerId: layer.id,
      frameId: f.id,
      x: 0,
      y: 0,
      width: s.sprite.width,
      height: s.sprite.height,
    }));
    return { layer, cels };
  },

  createGroup: (name, parentId = null) => {
    const s = get();
    const count = s.sprite.layers.filter((l) => l.kind === 'group').length;
    const layer: Layer = {
      id: makeId('l'),
      kind: 'group',
      name: name ?? `Group ${count + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      parentId,
      clippingMask: false,
      collapsed: false,
    };
    // No cels — a group has no pixels of its own (`docs/03-data-model.md` §2.1).
    return { layer, cels: [] };
  },

  createTilemapLayer: (tilesetId, grid, name, parentId = null) => {
    const s = get();
    const count = s.sprite.layers.filter((l) => l.kind === 'tilemap').length;
    const layer: Layer = {
      id: makeId('l'),
      kind: 'tilemap',
      name: name ?? `Tile Layer ${count + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      parentId,
      clippingMask: false,
      tilesetId,
      grid,
    };
    // One cel per frame, exactly like `createLayer` — the cel's *content* is
    // grid data (`model/tileGridBuffers.ts`), not a pixel buffer, resolved by
    // `insertLayer`/`insertFrame` below via `layer.kind === 'tilemap'`.
    const cels: Cel[] = s.sprite.frames.map((f) => ({
      id: makeId('c'),
      layerId: layer.id,
      frameId: f.id,
      x: 0,
      y: 0,
      width: s.sprite.width,
      height: s.sprite.height,
    }));
    return { layer, cels };
  },

  insertLayer: (layer, cels, index) =>
    set((s) => {
      for (const cel of cels) {
        if (cel.linkedTo) continue; // shares another cel's buffer/grid; nothing to allocate
        if (layer.kind === 'tilemap') {
          if (!getGrid(cel.id)) {
            const { cols, rows } = tileGridDims(cel, layer.grid);
            allocateGrid(cel.id, cols, rows);
          }
        } else if (!getBuffer(cel.id)) {
          allocateBuffer(cel.id, cel.width, cel.height);
        }
      }
      const layers = [...s.sprite.layers];
      layers.splice(Math.max(0, Math.min(index, layers.length)), 0, layer);
      return {
        sprite: { ...s.sprite, layers, cels: [...s.sprite.cels, ...cels] },
        revision: s.revision + 1,
      };
    }),

  removeLayerMetadata: (id) =>
    set((s) => {
      const layers = s.sprite.layers.filter((l) => l.id !== id);
      if (layers.length === s.sprite.layers.length) return s;
      return {
        sprite: {
          ...s.sprite,
          layers,
          cels: s.sprite.cels.filter((c) => c.layerId !== id),
        },
        activeLayerId:
          s.activeLayerId === id
            ? (layers[layers.length - 1]?.id ?? s.activeLayerId)
            : s.activeLayerId,
        revision: s.revision + 1,
      };
    }),

  swapLayers: (a, b) =>
    set((s) => {
      const ia = s.sprite.layers.findIndex((l) => l.id === a);
      const ib = s.sprite.layers.findIndex((l) => l.id === b);
      if (ia < 0 || ib < 0 || ia === ib) return s;
      const layers = [...s.sprite.layers];
      [layers[ia], layers[ib]] = [layers[ib], layers[ia]];
      return { sprite: { ...s.sprite, layers }, revision: s.revision + 1 };
    }),

  updateLayer: (id, patch) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        layers: s.sprite.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)),
      },
      revision: s.revision + 1,
    })),

  updateLayerSource: (id, source) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        layers: s.sprite.layers.map((l) =>
          l.id === id && l.kind === 'conversion' ? { ...l, source } : l,
        ),
      },
      revision: s.revision + 1,
    })),

  setGroupCollapsed: (id, collapsed) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        layers: s.sprite.layers.map((l) =>
          l.id === id && l.kind === 'group' ? { ...l, collapsed } : l,
        ),
      },
      revision: s.revision + 1,
    })),

  setActiveLayer: (id) => set({ activeLayerId: id }),

  layerIndex: (id) => get().sprite.layers.findIndex((l) => l.id === id),

  addLayer: (name) => {
    const { layer, cels } = get().createLayer(name);
    get().insertLayer(layer, cels, get().sprite.layers.length);
    get().setActiveLayer(layer.id);
  },

  removeLayer: (id) => {
    const s = get();
    // Deleting a group takes its descendants with it — an orphaned layer
    // pointing at a `parentId` that no longer exists is not a state anything
    // downstream (compositing, the panel's tree walk) should have to handle.
    const ids = [id, ...descendantIds(s.sprite.layers, id)];
    if (s.sprite.layers.length - ids.length < 1) return; // never leave zero layers
    for (const lid of ids) {
      get()
        .celsForLayer(lid)
        .forEach((c) => {
          // A linked cel owns no buffer of its own — every cel it could ever
          // link to also belongs to this same layer, so its target dies in
          // this same cascade and does not need a separate release here.
          if (!c.linkedTo) releaseBuffer(c.id);
        });
      get().removeLayerMetadata(lid);
    }
  },

  toggleLayerVisibility: (id) => {
    const layer = get().sprite.layers.find((l) => l.id === id);
    if (layer) get().updateLayer(id, { visible: !layer.visible });
  },

  celFor: (layerId, frameId) =>
    get().sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId),

  celsForLayer: (layerId) => get().sprite.cels.filter((c) => c.layerId === layerId),

  activeCel: () => {
    const s = get();
    return s.sprite.cels.find(
      (c) => c.layerId === s.activeLayerId && c.frameId === s.activeFrameId,
    );
  },

  createFrame: (durationMs = 100) => {
    const s = get();
    const frame: Frame = { id: makeId('f'), durationMs };
    // One cel per non-group layer — the frame axis's mirror of `createLayer`
    // making one cel per existing frame. Groups have no pixels of their own,
    // so they get no cel here either.
    const cels: Cel[] = s.sprite.layers
      .filter((l) => l.kind !== 'group')
      .map((l) => ({
        id: makeId('c'),
        layerId: l.id,
        frameId: frame.id,
        x: 0,
        y: 0,
        width: s.sprite.width,
        height: s.sprite.height,
      }));
    return { frame, cels };
  },

  insertFrame: (frame, cels, index) =>
    set((s) => {
      for (const cel of cels) {
        if (cel.linkedTo) continue; // shares another cel's buffer/grid
        const layer = s.sprite.layers.find((l) => l.id === cel.layerId);
        if (layer?.kind === 'tilemap') {
          if (!getGrid(cel.id)) {
            const { cols, rows } = tileGridDims(cel, layer.grid);
            allocateGrid(cel.id, cols, rows);
          }
        } else if (!getBuffer(cel.id)) {
          allocateBuffer(cel.id, cel.width, cel.height);
        }
      }
      const clampedIndex = Math.max(0, Math.min(index, s.sprite.frames.length));
      const frames = [...s.sprite.frames];
      frames.splice(clampedIndex, 0, frame);
      // A tag's `from`/`to` are frame *indices* — inserting a frame anywhere
      // at or before a tag's range has to renumber it, or the tag silently
      // starts pointing at different content (`model/tags.ts`).
      const tags = s.sprite.tags.map((t) => shiftTagRangeForInsert(t, clampedIndex));
      return {
        sprite: { ...s.sprite, frames, cels: [...s.sprite.cels, ...cels], tags },
        revision: s.revision + 1,
      };
    }),

  removeFrameMetadata: (id) =>
    set((s) => {
      const removedIndex = s.sprite.frames.findIndex((f) => f.id === id);
      const frames = s.sprite.frames.filter((f) => f.id !== id);
      if (frames.length === s.sprite.frames.length) return s;
      const tags = s.sprite.tags.map((t) => shiftTagRangeForRemove(t, removedIndex, frames.length));
      return {
        sprite: {
          ...s.sprite,
          frames,
          cels: s.sprite.cels.filter((c) => c.frameId !== id),
          tags,
        },
        activeFrameId:
          s.activeFrameId === id ? (frames[0]?.id ?? s.activeFrameId) : s.activeFrameId,
        revision: s.revision + 1,
      };
    }),

  swapFrames: (a, b) =>
    set((s) => {
      const ia = s.sprite.frames.findIndex((f) => f.id === a);
      const ib = s.sprite.frames.findIndex((f) => f.id === b);
      if (ia < 0 || ib < 0 || ia === ib) return s;
      const frames = [...s.sprite.frames];
      [frames[ia], frames[ib]] = [frames[ib], frames[ia]];
      return { sprite: { ...s.sprite, frames }, revision: s.revision + 1 };
    }),

  updateFrame: (id, patch) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        frames: s.sprite.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      },
      revision: s.revision + 1,
    })),

  setActiveFrame: (id) => set({ activeFrameId: id }),

  frameIndex: (id) => get().sprite.frames.findIndex((f) => f.id === id),

  celsForFrame: (frameId) => get().sprite.cels.filter((c) => c.frameId === frameId),

  setCelLink: (celId, linkedTo) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        cels: s.sprite.cels.map((c) => (c.id === celId ? { ...c, linkedTo } : c)),
      },
      revision: s.revision + 1,
    })),

  insertTag: (tag, index) =>
    set((s) => {
      const tags = [...s.sprite.tags];
      tags.splice(Math.max(0, Math.min(index, tags.length)), 0, tag);
      return { sprite: { ...s.sprite, tags }, revision: s.revision + 1 };
    }),

  removeTagMetadata: (id) =>
    set((s) => {
      const tags = s.sprite.tags.filter((t) => t.id !== id);
      if (tags.length === s.sprite.tags.length) return s;
      return { sprite: { ...s.sprite, tags }, revision: s.revision + 1 };
    }),

  updateTag: (id, patch) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        tags: s.sprite.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
      revision: s.revision + 1,
    })),

  tagIndex: (id) => get().sprite.tags.findIndex((t) => t.id === id),

  insertTileset: (tileset, index) =>
    set((s) => {
      const tilesets = [...s.sprite.tilesets];
      tilesets.splice(Math.max(0, Math.min(index, tilesets.length)), 0, tileset);
      return { sprite: { ...s.sprite, tilesets }, revision: s.revision + 1 };
    }),

  removeTilesetMetadata: (id) =>
    set((s) => {
      const tilesets = s.sprite.tilesets.filter((t) => t.id !== id);
      if (tilesets.length === s.sprite.tilesets.length) return s;
      return { sprite: { ...s.sprite, tilesets }, revision: s.revision + 1 };
    }),

  tilesetIndex: (id) => get().sprite.tilesets.findIndex((t) => t.id === id),

  insertTileEntry: (tilesetId, entry, index) =>
    set((s) => {
      const tilesets = s.sprite.tilesets.map((t) => {
        if (t.id !== tilesetId) return t;
        const tiles = [...t.tiles];
        tiles.splice(Math.max(0, Math.min(index, tiles.length)), 0, entry);
        return { ...t, tiles };
      });
      return { sprite: { ...s.sprite, tilesets }, revision: s.revision + 1 };
    }),

  removeTileEntryMetadata: (tilesetId, tileEntryId) =>
    set((s) => {
      const tilesets = s.sprite.tilesets.map((t) =>
        t.id === tilesetId ? { ...t, tiles: t.tiles.filter((e) => e.id !== tileEntryId) } : t,
      );
      return { sprite: { ...s.sprite, tilesets }, revision: s.revision + 1 };
    }),

  setTilemapCell: (celId, col, row, tileId) => {
    const s = get();
    const cel = s.sprite.cels.find((c) => c.id === celId);
    if (!cel) return;
    const layer = s.sprite.layers.find((l) => l.id === cel.layerId);
    if (layer?.kind !== 'tilemap') return;
    const bufferId = celBufferId(cel);
    const grid = getGrid(bufferId);
    if (!grid) return;
    const { cols, rows } = tileGridDims(cel, layer.grid);
    setGridCell(grid, cols, rows, col, row, tileId);
    bumpGridRevision(bufferId);
  },
}));

export type { CelId };
