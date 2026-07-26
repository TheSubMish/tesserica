/**
 * Document state. Metadata only — pixels live in `model/pixelBuffers.ts`.
 *
 * `revision` is bumped whenever pixel data changes so the renderer knows to
 * redraw without the pixels themselves ever entering React state.
 */

import { create } from 'zustand';
import type { Cel, CelId, Frame, Layer, LayerId, Sprite } from '../model/types';
import { allocateBuffer, releaseBuffer } from '../model/pixelBuffers';

let nextId = 1;
const makeId = (prefix: string): string => `${prefix}${nextId++}`;

interface DocumentState {
  sprite: Sprite;
  activeLayerId: LayerId;
  activeFrameId: string;
  /** Bumped on every pixel mutation; the canvas redraws when it changes. */
  revision: number;

  touch(): void;
  addLayer(name?: string): void;
  removeLayer(id: LayerId): void;
  setActiveLayer(id: LayerId): void;
  toggleLayerVisibility(id: LayerId): void;
  activeCel(): Cel | undefined;
  celFor(layerId: LayerId, frameId: string): Cel | undefined;
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

  touch: () => set((s) => ({ revision: s.revision + 1 })),

  addLayer: (name) =>
    set((s) => {
      const layer: Layer = {
        id: makeId('l'),
        kind: 'raster',
        name: name ?? `Layer ${s.sprite.layers.length + 1}`,
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
      };
      // One cel per frame. Phase 0 has a single frame, but writing it as a map
      // over frames means adding frames in Phase 4 needs no change here.
      const cels: Cel[] = s.sprite.frames.map((f) => {
        const cel: Cel = {
          id: makeId('c'),
          layerId: layer.id,
          frameId: f.id,
          x: 0,
          y: 0,
          width: s.sprite.width,
          height: s.sprite.height,
        };
        allocateBuffer(cel.id, s.sprite.width, s.sprite.height);
        return cel;
      });

      return {
        sprite: {
          ...s.sprite,
          layers: [...s.sprite.layers, layer],
          cels: [...s.sprite.cels, ...cels],
        },
        activeLayerId: layer.id,
        revision: s.revision + 1,
      };
    }),

  removeLayer: (id) =>
    set((s) => {
      if (s.sprite.layers.length <= 1) return s; // never leave zero layers

      const doomed = s.sprite.cels.filter((c) => c.layerId === id);
      doomed.forEach((c) => releaseBuffer(c.id));

      const layers = s.sprite.layers.filter((l) => l.id !== id);
      return {
        sprite: {
          ...s.sprite,
          layers,
          cels: s.sprite.cels.filter((c) => c.layerId !== id),
        },
        activeLayerId: s.activeLayerId === id ? layers[layers.length - 1].id : s.activeLayerId,
        revision: s.revision + 1,
      };
    }),

  setActiveLayer: (id) => set({ activeLayerId: id }),

  toggleLayerVisibility: (id) =>
    set((s) => ({
      sprite: {
        ...s.sprite,
        layers: s.sprite.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
      },
      revision: s.revision + 1,
    })),

  celFor: (layerId, frameId) =>
    get().sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId),

  activeCel: () => {
    const s = get();
    return s.sprite.cels.find(
      (c) => c.layerId === s.activeLayerId && c.frameId === s.activeFrameId,
    );
  },
}));

export type { CelId };
