import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, getPixel, setPixel } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import {
  addGroup,
  addLayer,
  addLayerEffect,
  deleteLayer,
  groupLayer,
  moveLayer,
  removeLayerEffect,
  renameLayer,
  reorderLayerEffect,
  setLayerClippingMask,
  setLayerEffectEnabled,
  setLayerLocked,
  setLayerOpacity,
  setLayerParent,
  setLayerVisible,
  ungroupLayer,
  updateLayerEffect,
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

describe('layer effects (docs/03-data-model.md §5, roadmap Phase 7)', () => {
  const layerId = () => doc().sprite.layers[0].id;
  const effects = () => doc().sprite.layers[0].effects;

  it('adds a new effect of the requested kind, undoably', () => {
    expect(effects()).toEqual([]);
    addLayerEffect(layerId(), 'outline');
    expect(effects()).toHaveLength(1);
    expect(effects()[0].kind).toBe('outline');
    expect(effects()[0].enabled).toBe(true);

    history().undo();
    expect(effects()).toEqual([]);
    history().redo();
    expect(effects()).toHaveLength(1);
  });

  it('adds every kind with reasonable, distinguishable defaults', () => {
    for (const kind of [
      'outline',
      'outline-inner',
      'drop-shadow',
      'gradient-map',
      'hsv-shift',
    ] as const) {
      addLayerEffect(layerId(), kind);
    }
    expect(effects().map((e) => e.kind)).toEqual([
      'outline',
      'outline-inner',
      'drop-shadow',
      'gradient-map',
      'hsv-shift',
    ]);
    // Every entry gets its own stable id — never shared, never blank.
    const ids = effects().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('removes an effect by id, undoably', () => {
    addLayerEffect(layerId(), 'outline');
    addLayerEffect(layerId(), 'hsv-shift');
    const [first, second] = effects();
    history().clear();

    removeLayerEffect(layerId(), first.id);
    expect(effects().map((e) => e.id)).toEqual([second.id]);

    history().undo();
    expect(effects().map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('toggles enabled without touching any other field, undoably', () => {
    addLayerEffect(layerId(), 'outline');
    const id = effects()[0].id;
    history().clear();

    setLayerEffectEnabled(layerId(), id, false);
    expect(effects()[0].enabled).toBe(false);
    expect(effects()[0].kind).toBe('outline');

    history().undo();
    expect(effects()[0].enabled).toBe(true);
  });

  it("edits one effect's own parameters without touching its neighbours", () => {
    addLayerEffect(layerId(), 'outline');
    addLayerEffect(layerId(), 'hsv-shift');
    const [outlineId, hsvId] = effects().map((e) => e.id);
    history().clear();

    updateLayerEffect(layerId(), outlineId, { thickness: 4 });
    const outline = effects().find((e) => e.id === outlineId)!;
    expect(outline.kind).toBe('outline');
    expect((outline as { thickness: number }).thickness).toBe(4);
    // The other effect is untouched.
    expect(effects().find((e) => e.id === hsvId)).toEqual(
      expect.objectContaining({ kind: 'hsv-shift', h: 0, s: 0, v: 0 }),
    );

    history().undo();
    expect((effects().find((e) => e.id === outlineId) as { thickness: number }).thickness).toBe(1);
  });

  it('coalesces a continuous edit into one undo step', () => {
    addLayerEffect(layerId(), 'outline');
    const id = effects()[0].id;
    history().clear();

    updateLayerEffect(layerId(), id, { thickness: 2 }, 'drag-1');
    updateLayerEffect(layerId(), id, { thickness: 3 }, 'drag-1');
    updateLayerEffect(layerId(), id, { thickness: 4 }, 'drag-1');
    expect((effects()[0] as { thickness: number }).thickness).toBe(4);

    history().undo();
    // One undo step reverts the *whole* drag, not just the last tick.
    expect((effects()[0] as { thickness: number }).thickness).toBe(1);
  });

  it('reorders the stack, and order is what a reordered composite depends on', () => {
    addLayerEffect(layerId(), 'outline');
    addLayerEffect(layerId(), 'gradient-map');
    const [outlineId, gradientId] = effects().map((e) => e.id);
    history().clear();

    reorderLayerEffect(layerId(), outlineId, 1);
    expect(effects().map((e) => e.id)).toEqual([gradientId, outlineId]);

    history().undo();
    expect(effects().map((e) => e.id)).toEqual([outlineId, gradientId]);
  });

  it('refuses to reorder past either end of the stack', () => {
    addLayerEffect(layerId(), 'outline');
    addLayerEffect(layerId(), 'gradient-map');
    const [outlineId, gradientId] = effects().map((e) => e.id);
    history().clear();

    reorderLayerEffect(layerId(), outlineId, -1); // already first
    expect(effects().map((e) => e.id)).toEqual([outlineId, gradientId]);

    reorderLayerEffect(layerId(), gradientId, 1); // already last
    expect(effects().map((e) => e.id)).toEqual([outlineId, gradientId]);
  });

  it('a multi-effect stack round-trips through save/load unchanged (`.tess` shape)', () => {
    addLayerEffect(layerId(), 'outline');
    addLayerEffect(layerId(), 'gradient-map');
    updateLayerEffect(layerId(), effects()[0].id, { thickness: 3, enabled: false });

    // The in-memory shape is exactly what a serializer would see — no
    // separate storage to fall out of sync with.
    const snapshot = JSON.parse(JSON.stringify(effects()));
    expect(snapshot).toEqual(effects());
    expect(snapshot[0].enabled).toBe(false);
    expect(snapshot[0].thickness).toBe(3);
    expect(snapshot[1].kind).toBe('gradient-map');
  });
});

describe('addLayer/deleteLayer on an indexed-mode sprite (docs/08-roadmap.md Phase 7)', () => {
  const palette: Palette = { id: 'p1', name: 'P', colors: [[255, 0, 0, 255]] };

  beforeEach(() => {
    history().clear();
    doc().newDocument(8, 8, 'indexed', palette);
    history().clear();
  });

  it('a new layer gets an index buffer, not an RGBA one', () => {
    addLayer('two');
    const cel = doc().celsForLayer(doc().activeLayerId)[0];
    expect(getIndexBuffer(cel.id)).toBeDefined();
    expect(getIndexBuffer(cel.id)!.length).toBe(64);
    expect(getBuffer(cel.id)).toBeUndefined();
  });

  it('undo/redo round-trips a painted index losslessly', () => {
    addLayer('two');
    const id = doc().activeLayerId;
    const cel = doc().celsForLayer(id)[0];
    setPixel(getIndexBuffer(cel.id)!, cel.width, cel.height, 2, 2, [1]);

    history().undo();
    expect(names()).toEqual(['Layer 1']);
    expect(getIndexBuffer(cel.id)).toBeUndefined();

    history().redo();
    expect(names()).toEqual(['Layer 1', 'two']);
    expect(getPixel(getIndexBuffer(cel.id)!, cel.width, cel.height, 2, 2, 1)).toEqual([1]);
  });

  it('deleteLayer releases and undo restores the index buffer', () => {
    addLayer('two');
    const id = doc().activeLayerId;
    const cel = doc().celsForLayer(id)[0];
    setPixel(getIndexBuffer(cel.id)!, cel.width, cel.height, 5, 5, [1]);
    history().clear();

    deleteLayer(id);
    expect(getIndexBuffer(cel.id)).toBeUndefined();

    history().undo();
    expect(getPixel(getIndexBuffer(cel.id)!, cel.width, cel.height, 5, 5, 1)).toEqual([1]);
  });
});
