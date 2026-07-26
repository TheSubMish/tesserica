import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import {
  addLayer,
  deleteLayer,
  moveLayer,
  renameLayer,
  setLayerLocked,
  setLayerOpacity,
  setLayerVisible,
} from './layerCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const names = () => doc().sprite.layers.map((l) => l.name);

/** Reset to a single "Layer 1" between tests without reimporting the module. */
beforeEach(() => {
  history().clear();
  while (doc().sprite.layers.length > 1) {
    doc().removeLayer(doc().sprite.layers[doc().sprite.layers.length - 1].id);
  }
  const only = doc().sprite.layers[0];
  doc().updateLayer(only.id, {
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
  });
  doc().setActiveLayer(only.id);
  history().clear();
});

describe('addLayer', () => {
  it('inserts above the active layer and selects it', () => {
    addLayer('two');
    expect(names()).toEqual(['Layer 1', 'two']);
    expect(doc().sprite.layers[1].id).toBe(doc().activeLayerId);

    // With "Layer 1" active again, the next add goes between the two.
    doc().setActiveLayer(doc().sprite.layers[0].id);
    addLayer('middle');
    expect(names()).toEqual(['Layer 1', 'middle', 'two']);
  });

  it('allocates a cel buffer per frame', () => {
    addLayer('two');
    const cels = doc().celsForLayer(doc().activeLayerId);
    expect(cels).toHaveLength(doc().sprite.frames.length);
    for (const c of cels) expect(getBuffer(c.id)).toBeDefined();
  });

  it('undoes and redoes, keeping the pixels drawn on it', () => {
    addLayer('two');
    const id = doc().activeLayerId;
    const cel = doc().celsForLayer(id)[0];
    setPixel(getBuffer(cel.id)!, cel.width, cel.height, 2, 2, [1, 2, 3, 255]);

    history().undo();
    expect(names()).toEqual(['Layer 1']);
    expect(getBuffer(cel.id)).toBeUndefined();

    history().redo();
    expect(names()).toEqual(['Layer 1', 'two']);
    // The drawing must survive the round trip — an undone add still owns its
    // pixels.
    expect(getPixel(getBuffer(cel.id)!, cel.width, cel.height, 2, 2)).toEqual([1, 2, 3, 255]);
  });
});

describe('deleteLayer', () => {
  it('removes the layer and gives its pixels back on undo', () => {
    addLayer('two');
    const id = doc().activeLayerId;
    const cel = doc().celsForLayer(id)[0];
    setPixel(getBuffer(cel.id)!, cel.width, cel.height, 5, 5, [7, 7, 7, 255]);

    deleteLayer(id);
    expect(names()).toEqual(['Layer 1']);
    expect(getBuffer(cel.id)).toBeUndefined();

    history().undo();
    expect(names()).toEqual(['Layer 1', 'two']);
    expect(getPixel(getBuffer(cel.id)!, cel.width, cel.height, 5, 5)).toEqual([7, 7, 7, 255]);
  });

  it('charges the retained pixels to the history budget', () => {
    addLayer('two');
    const id = doc().activeLayerId;
    deleteLayer(id);
    // 64×64×4 for the one cel, plus the zero-cost add step.
    expect(history().memoryUsed).toBe(64 * 64 * 4);
  });

  it('restores the layer to its original position, not the top', () => {
    addLayer('two');
    addLayer('three');
    expect(names()).toEqual(['Layer 1', 'two', 'three']);

    deleteLayer(doc().sprite.layers[1].id);
    expect(names()).toEqual(['Layer 1', 'three']);

    history().undo();
    expect(names()).toEqual(['Layer 1', 'two', 'three']);
  });

  it('refuses to leave the document with zero layers', () => {
    deleteLayer(doc().sprite.layers[0].id);
    expect(doc().sprite.layers).toHaveLength(1);
    expect(history().past).toHaveLength(0);
  });
});

describe('moveLayer', () => {
  it('reorders and reverses cleanly', () => {
    addLayer('two');
    addLayer('three');
    const id = doc().sprite.layers[0].id;

    moveLayer(id, 1);
    expect(names()).toEqual(['two', 'Layer 1', 'three']);

    history().undo();
    expect(names()).toEqual(['Layer 1', 'two', 'three']);
  });

  it('does nothing at the ends of the stack', () => {
    addLayer('two');
    history().clear();
    moveLayer(doc().sprite.layers[0].id, -1);
    moveLayer(doc().sprite.layers[1].id, 1);
    expect(names()).toEqual(['Layer 1', 'two']);
    expect(history().past).toHaveLength(0);
  });
});

describe('property edits', () => {
  it('renames, and undoes back to the old name', () => {
    const id = doc().sprite.layers[0].id;
    renameLayer(id, 'outline');
    expect(names()).toEqual(['outline']);
    history().undo();
    expect(names()).toEqual(['Layer 1']);
  });

  it('ignores an empty rename', () => {
    const id = doc().sprite.layers[0].id;
    renameLayer(id, '   ');
    expect(names()).toEqual(['Layer 1']);
    expect(history().past).toHaveLength(0);
  });

  it('records nothing when the value is unchanged', () => {
    const id = doc().sprite.layers[0].id;
    setLayerVisible(id, true);
    expect(history().past).toHaveLength(0);
  });

  it('toggles visibility and lock', () => {
    const id = doc().sprite.layers[0].id;
    setLayerVisible(id, false);
    setLayerLocked(id, true);
    const l = doc().sprite.layers[0];
    expect([l.visible, l.locked]).toEqual([false, true]);

    history().undo();
    history().undo();
    expect([doc().sprite.layers[0].visible, doc().sprite.layers[0].locked]).toEqual([true, false]);
  });
});

describe('opacity coalescing', () => {
  it('collapses one slider drag into a single undo step', () => {
    const id = doc().sprite.layers[0].id;
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5]) setLayerOpacity(id, v, 1);

    expect(history().past).toHaveLength(1);
    expect(doc().sprite.layers[0].opacity).toBe(0.5);

    history().undo();
    expect(doc().sprite.layers[0].opacity).toBe(1);
  });

  it('keeps two separate drags separate', () => {
    const id = doc().sprite.layers[0].id;
    setLayerOpacity(id, 0.8, 1);
    setLayerOpacity(id, 0.5, 2);

    expect(history().past).toHaveLength(2);
    history().undo();
    expect(doc().sprite.layers[0].opacity).toBe(0.8);
  });

  it('clamps out-of-range values', () => {
    const id = doc().sprite.layers[0].id;
    setLayerOpacity(id, 5, 1);
    expect(doc().sprite.layers[0].opacity).toBe(1);
    setLayerOpacity(id, -2, 2);
    expect(doc().sprite.layers[0].opacity).toBe(0);
  });
});
