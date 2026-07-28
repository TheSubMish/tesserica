import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import {
  addGroup,
  addLayer,
  deleteLayer,
  groupLayer,
  moveLayer,
  renameLayer,
  setLayerClippingMask,
  setLayerLocked,
  setLayerOpacity,
  setLayerParent,
  setLayerVisible,
  ungroupLayer,
} from './layerCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const names = () => doc().sprite.layers.map((l) => l.name);

/**
 * Reset to a single "Layer 1" between tests without reimporting the module.
 *
 * This rebuilds the document rather than deleting layers one by one. Peeling
 * layers off the end of the flat array cannot express "empty the document":
 * `removeLayer` cascades into a group's descendants and refuses any delete
 * that would leave zero layers, so a trailing group whose children sit
 * earlier in the array — exactly what `groupLayer` produces — is undeletable
 * and the loop never terminates.
 */
beforeEach(() => {
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  doc().updateLayer(doc().sprite.layers[0].id, { name: 'Layer 1' });
  doc().setActiveLayer(doc().sprite.layers[0].id);
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

describe('groups', () => {
  it('creates an empty group as a sibling of the active layer', () => {
    addGroup('Folder');
    const g = doc().sprite.layers.find((l) => l.name === 'Folder');
    expect(g?.kind).toBe('group');
    expect(g?.parentId).toBeNull();
    // A group has no pixels of its own.
    expect(doc().celsForLayer(g!.id)).toHaveLength(0);
  });

  it('wraps a layer in a new group as one undo step', () => {
    const id = doc().sprite.layers[0].id;
    groupLayer(id);

    const layer = doc().sprite.layers.find((l) => l.id === id)!;
    expect(layer.parentId).not.toBeNull();
    const group = doc().sprite.layers.find((l) => l.id === layer.parentId)!;
    expect(group.kind).toBe('group');

    history().undo();
    expect(doc().sprite.layers.find((l) => l.id === id)!.parentId).toBeNull();
    expect(doc().sprite.layers.some((l) => l.kind === 'group')).toBe(false);
  });

  it('reparents a layer into and out of a group', () => {
    addGroup('Folder');
    const group = doc().sprite.layers.find((l) => l.kind === 'group')!;
    const leaf = doc().sprite.layers.find((l) => l.kind !== 'group')!;

    setLayerParent(leaf.id, group.id);
    expect(doc().sprite.layers.find((l) => l.id === leaf.id)!.parentId).toBe(group.id);

    history().undo();
    expect(doc().sprite.layers.find((l) => l.id === leaf.id)!.parentId).toBeNull();
  });

  it('refuses to nest a group inside its own descendant', () => {
    addGroup('Outer');
    const outer = doc().sprite.layers.find((l) => l.name === 'Outer')!;
    addGroup('Inner');
    const inner = doc().sprite.layers.find((l) => l.name === 'Inner')!;
    setLayerParent(inner.id, outer.id);
    history().clear();

    setLayerParent(outer.id, inner.id);
    expect(doc().sprite.layers.find((l) => l.id === outer.id)!.parentId).toBeNull();
    expect(history().past).toHaveLength(0);
  });

  it('deletes a group and every descendant as one undo step', () => {
    addLayer('survivor'); // otherwise deleting the group would zero out the document
    addGroup('Folder');
    const group = doc().sprite.layers.find((l) => l.name === 'Folder')!;
    const leaf = doc().sprite.layers.find((l) => l.name === 'Layer 1')!;
    setLayerParent(leaf.id, group.id);
    history().clear();

    const before = doc().sprite.layers.length;
    deleteLayer(group.id);
    expect(doc().sprite.layers).toHaveLength(before - 2);
    expect(doc().sprite.layers.some((l) => l.id === group.id || l.id === leaf.id)).toBe(false);

    history().undo();
    expect(doc().sprite.layers).toHaveLength(before);
    expect(doc().sprite.layers.find((l) => l.id === leaf.id)!.parentId).toBe(group.id);
  });

  it('dissolves a group, promoting its children back to its own parent', () => {
    addGroup('Outer');
    const outer = doc().sprite.layers.find((l) => l.name === 'Outer')!;
    const leaf = doc().sprite.layers.find((l) => l.kind !== 'group')!;
    setLayerParent(leaf.id, outer.id);
    history().clear();

    ungroupLayer(outer.id);
    expect(doc().sprite.layers.some((l) => l.id === outer.id)).toBe(false);
    expect(doc().sprite.layers.find((l) => l.id === leaf.id)!.parentId).toBeNull();

    history().undo();
    expect(doc().sprite.layers.some((l) => l.id === outer.id)).toBe(true);
    expect(doc().sprite.layers.find((l) => l.id === leaf.id)!.parentId).toBe(outer.id);
  });

  it('moves a layer relative to its siblings only, not the whole flat array', () => {
    addGroup('Folder');
    const group = doc().sprite.layers.find((l) => l.name === 'Folder')!;
    addLayer('inA');
    setLayerParent(doc().activeLayerId, group.id);
    addLayer('inB');
    setLayerParent(doc().activeLayerId, group.id);
    history().clear();

    const childNames = () =>
      doc()
        .sprite.layers.filter((l) => l.parentId === group.id)
        .map((l) => l.name);
    expect(childNames()).toEqual(['inA', 'inB']);

    const inA = doc().sprite.layers.find((l) => l.name === 'inA')!;
    moveLayer(inA.id, 1);
    expect(childNames()).toEqual(['inB', 'inA']);
    // The top-level stack (bg + the group itself) is untouched by a move
    // that happened entirely inside the group.
    expect(doc().sprite.layers.filter((l) => l.parentId === null)).toHaveLength(2);

    history().undo();
    expect(childNames()).toEqual(['inA', 'inB']);
  });
});

describe('clipping masks', () => {
  it('toggles and undoes', () => {
    const id = doc().sprite.layers[0].id;
    setLayerClippingMask(id, true);
    expect(doc().sprite.layers[0].clippingMask).toBe(true);
    history().undo();
    expect(doc().sprite.layers[0].clippingMask).toBe(false);
  });
});
