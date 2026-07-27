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
   * Signal a change. Passing the cel that changed lets the renderer re-upload
   * only that layer; omitting it invalidates the whole composite.
   */
  touch(celId?: CelId): void;

  // ---- primitives ----
  /** Build a detached raster layer plus one cel per frame. */
  createLayer(name?: string): { layer: Layer; cels: Cel[] };
  /** Insert a layer at `index` in the bottom→top order. */
  insertLayer(layer: Layer, cels: Cel[], index: number): void;
  /**
   * Drop a layer's metadata and cels. Buffers are **not** released — the
   * caller owns them, which is what lets a delete command hand them back.
   */
  removeLayerMetadata(id: LayerId): void;
  moveLayer(id: LayerId, toIndex: number): void;
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

  touch: (celId) => {
    if (celId) bumpCelRevision(celId);
    set((s) => ({ revision: s.revision + 1 }));
  },

  createLayer: (name) => {
    const s = get();
    const layer: Layer = {
      id: makeId('l'),
      kind: 'raster',
      name: name ?? `Layer ${s.sprite.layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
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

  moveLayer: (id, toIndex) =>
    set((s) => {
      const from = s.sprite.layers.findIndex((l) => l.id === id);
      if (from < 0) return s;
      const clamped = Math.max(0, Math.min(toIndex, s.sprite.layers.length - 1));
      if (clamped === from) return s;
      const layers = [...s.sprite.layers];
      const [moved] = layers.splice(from, 1);
      layers.splice(clamped, 0, moved);
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

  setActiveLayer: (id) => set({ activeLayerId: id }),

  layerIndex: (id) => get().sprite.layers.findIndex((l) => l.id === id),

  addLayer: (name) => {
    const { layer, cels } = get().createLayer(name);
    get().insertLayer(layer, cels, get().sprite.layers.length);
    get().setActiveLayer(layer.id);
  },

  removeLayer: (id) => {
    if (get().sprite.layers.length <= 1) return; // never leave zero layers
    get()
      .celsForLayer(id)
      .forEach((c) => releaseBuffer(c.id));
    get().removeLayerMetadata(id);
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
