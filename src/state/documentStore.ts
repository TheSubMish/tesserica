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
  Layer,
  LayerBase,
  LayerId,
  Sprite,
} from '../model/types';
import { descendantIds } from '../model/layerTree';
import {
  allocateBuffer,
  bumpCelRevision,
  clearAllBuffers,
  getBuffer,
  releaseBuffer,
  setBuffer,
} from '../model/pixelBuffers';

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
  /** Replace the whole document, e.g. after opening a `.tess`. */
  replaceDocument(sprite: Sprite, pixels: Map<CelId, Uint8ClampedArray>): void;
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
    sprite: { width, height, layers: [layer], frames: [frame], cels: [cel] },
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

  replaceDocument: (sprite, pixels) => {
    // The old document's buffers are unreachable the moment the sprite is
    // swapped, so drop them rather than leaking them for the process lifetime.
    clearAllBuffers();
    reserveIds([
      ...sprite.layers.map((l) => l.id),
      ...sprite.frames.map((f) => f.id),
      ...sprite.cels.map((c) => c.id),
    ]);

    for (const cel of sprite.cels) {
      const buf = pixels.get(cel.id);
      if (buf && buf.length === cel.width * cel.height * 4) setBuffer(cel.id, buf);
      else allocateBuffer(cel.id, cel.width, cel.height);
    }

    set((s) => ({
      sprite,
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
    const sprite: Sprite = { width, height, layers: [layer], frames: [frame], cels: [cel] };
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

  insertLayer: (layer, cels, index) =>
    set((s) => {
      for (const cel of cels) {
        if (!getBuffer(cel.id)) allocateBuffer(cel.id, cel.width, cel.height);
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
        .forEach((c) => releaseBuffer(c.id));
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
}));

export type { CelId };
