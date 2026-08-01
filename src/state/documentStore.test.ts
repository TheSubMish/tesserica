import { describe, expect, it } from 'vitest';
import { getBuffer } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import type { Palette } from '../model/types';
import { useDocumentStore } from './documentStore';

/**
 * The store is a module singleton created at import time, which is exactly how
 * the app uses it. Vitest isolates modules per test file, so the initial
 * document below is the real one the app boots with.
 */

describe('initial document', () => {
  it('opens with exactly one raster layer, one frame and one cel', () => {
    const { sprite } = useDocumentStore.getState();
    expect(sprite.layers).toHaveLength(1);
    expect(sprite.layers[0].kind).toBe('raster');
    expect(sprite.frames).toHaveLength(1);
    expect(sprite.cels).toHaveLength(1);
  });

  it('allocates a transparent buffer sized to the sprite', () => {
    const { sprite } = useDocumentStore.getState();
    const buf = getBuffer(sprite.cels[0].id);
    expect(buf).toBeDefined();
    expect(buf).toHaveLength(sprite.width * sprite.height * 4);
    expect(buf!.every((v) => v === 0)).toBe(true);
  });

  it('makes that layer and frame active, and activeCel resolves to their cel', () => {
    const s = useDocumentStore.getState();
    expect(s.activeLayerId).toBe(s.sprite.layers[0].id);
    expect(s.activeFrameId).toBe(s.sprite.frames[0].id);
    expect(s.activeCel()).toBe(s.sprite.cels[0]);
  });

  it('defaults to RGBA — newDocument only produces indexed storage on request (Phase 7)', () => {
    // Four bytes per pixel, not one index per pixel, unless newDocument was
    // asked for `'indexed'` (docs/08-roadmap.md Phase 7).
    const { sprite } = useDocumentStore.getState();
    expect(sprite.colorMode).toBe('rgba');
    expect(getBuffer(sprite.cels[0].id)!.length % 4).toBe(0);
  });
});

describe('revision', () => {
  it('advances on touch, so the canvas redraws without pixels entering React state', () => {
    const before = useDocumentStore.getState().revision;
    useDocumentStore.getState().touch();
    expect(useDocumentStore.getState().revision).toBe(before + 1);
  });
});

describe('addLayer', () => {
  it('adds one cel per frame and allocates a buffer for each', () => {
    const framesBefore = useDocumentStore.getState().sprite.frames.length;
    const celsBefore = useDocumentStore.getState().sprite.cels.length;

    useDocumentStore.getState().addLayer();

    const s = useDocumentStore.getState();
    expect(s.sprite.cels).toHaveLength(celsBefore + framesBefore);
    for (const cel of s.sprite.cels) {
      expect(getBuffer(cel.id)).toBeDefined();
    }
  });

  it('stacks bottom to top and selects the new layer', () => {
    const store = useDocumentStore.getState();
    store.addLayer('above');
    const s = useDocumentStore.getState();
    expect(s.sprite.layers[s.sprite.layers.length - 1].name).toBe('above');
    expect(s.activeLayerId).toBe(s.sprite.layers[s.sprite.layers.length - 1].id);
  });
});

describe('removeLayer', () => {
  it('releases the removed layer’s buffers', () => {
    useDocumentStore.getState().addLayer();
    const doomed = useDocumentStore.getState().activeLayerId;
    const celIds = useDocumentStore
      .getState()
      .sprite.cels.filter((c) => c.layerId === doomed)
      .map((c) => c.id);

    useDocumentStore.getState().removeLayer(doomed);

    for (const id of celIds) {
      expect(getBuffer(id)).toBeUndefined();
    }
  });

  it('refuses to leave the document with zero layers', () => {
    let s = useDocumentStore.getState();
    while (s.sprite.layers.length > 1) {
      s.removeLayer(s.sprite.layers[0].id);
      s = useDocumentStore.getState();
    }

    s.removeLayer(s.sprite.layers[0].id);
    expect(useDocumentStore.getState().sprite.layers).toHaveLength(1);
  });

  it('moves the selection to a surviving layer', () => {
    useDocumentStore.getState().addLayer();
    const removed = useDocumentStore.getState().activeLayerId;
    useDocumentStore.getState().removeLayer(removed);

    const s = useDocumentStore.getState();
    expect(s.activeLayerId).not.toBe(removed);
    expect(s.sprite.layers.some((l) => l.id === s.activeLayerId)).toBe(true);
  });
});

describe('newDocument', () => {
  it('replaces the sprite with a single blank layer at the requested size', () => {
    useDocumentStore.getState().addLayer('extra'); // prove the old layers are gone, not appended to
    useDocumentStore.getState().newDocument(12, 9);

    const s = useDocumentStore.getState();
    expect([s.sprite.width, s.sprite.height]).toEqual([12, 9]);
    expect(s.sprite.layers).toHaveLength(1);
    expect(s.sprite.frames).toHaveLength(1);
    expect(s.sprite.cels).toHaveLength(1);
    expect(getBuffer(s.sprite.cels[0].id)?.length).toBe(12 * 9 * 4);
  });

  it('never mints an id that collides with one from the replaced document', () => {
    const staleIds = useDocumentStore.getState().sprite.layers.map((l) => l.id);
    useDocumentStore.getState().newDocument(4, 4);
    const freshIds = useDocumentStore.getState().sprite.layers.map((l) => l.id);
    expect(staleIds.some((id) => freshIds.includes(id))).toBe(false);
  });
});

describe('indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  const palette: Palette = {
    id: 'p1',
    name: 'P',
    colors: [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  it('newDocument("indexed") allocates a one-byte-per-pixel index buffer, not RGBA', () => {
    useDocumentStore.getState().newDocument(6, 5, 'indexed', palette);
    const s = useDocumentStore.getState();
    expect(s.sprite.colorMode).toBe('indexed');
    expect(s.sprite.palette).toEqual(palette);
    expect(getBuffer(s.sprite.cels[0].id)).toBeUndefined(); // not in the RGBA store
    expect(getIndexBuffer(s.sprite.cels[0].id)?.length).toBe(6 * 5);
  });

  it('addLayer on an indexed sprite allocates an index buffer for the new layer too', () => {
    useDocumentStore.getState().newDocument(4, 4, 'indexed', palette);
    const before = useDocumentStore.getState().sprite.cels.length;

    useDocumentStore.getState().addLayer();

    const s = useDocumentStore.getState();
    expect(s.sprite.cels.length).toBeGreaterThan(before);
    for (const cel of s.sprite.cels) {
      expect(getIndexBuffer(cel.id)).toBeDefined();
      expect(getBuffer(cel.id)).toBeUndefined();
    }
  });

  it('removeLayer on an indexed sprite releases the index buffer, not the RGBA one', () => {
    useDocumentStore.getState().newDocument(4, 4, 'indexed', palette);
    useDocumentStore.getState().addLayer();
    const doomed = useDocumentStore.getState().activeLayerId;
    const celIds = useDocumentStore
      .getState()
      .sprite.cels.filter((c) => c.layerId === doomed)
      .map((c) => c.id);

    useDocumentStore.getState().removeLayer(doomed);

    for (const id of celIds) {
      expect(getIndexBuffer(id)).toBeUndefined();
    }
  });

  it('newDocument("rgba") (the default) is unaffected by ever having created an indexed document', () => {
    useDocumentStore.getState().newDocument(4, 4, 'indexed', palette);
    useDocumentStore.getState().newDocument(4, 4);
    const s = useDocumentStore.getState();
    expect(s.sprite.colorMode).toBe('rgba');
    expect(getBuffer(s.sprite.cels[0].id)?.length).toBe(4 * 4 * 4);
  });
});

describe('toggleLayerVisibility', () => {
  it('flips visibility and bumps the revision so the canvas redraws', () => {
    const s = useDocumentStore.getState();
    const id = s.sprite.layers[0].id;
    const before = s.revision;

    s.toggleLayerVisibility(id);

    const after = useDocumentStore.getState();
    expect(after.sprite.layers.find((l) => l.id === id)!.visible).toBe(false);
    expect(after.revision).toBe(before + 1);
  });
});
