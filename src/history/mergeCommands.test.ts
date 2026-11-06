import { beforeEach, describe, expect, it } from 'vitest';

import { getBuffer, setPixel } from '../model/pixelBuffers';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { addGroup, setLayerOpacity, setLayerVisible } from './layerCommands';
import { flattenLayers, layerBelow, mergeDown } from './mergeCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

const RED = [255, 0, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;

/** Two layers: "Layer 1" (bottom) and "Top". Returns both cel ids; Top is active. */
function twoLayers() {
  doc().newDocument(4, 4);
  const bottom = doc().activeCel()!.id;
  doc().addLayer('Top');
  const top = doc().activeCel()!.id;
  history().clear();
  return { bottom, top };
}

const px = (id: string, x: number, y: number) => {
  const i = (y * 4 + x) * 4;
  return [...getBuffer(id)!.slice(i, i + 4)];
};

beforeEach(() => history().clear());

describe('mergeDown', () => {
  it('paints the upper layer onto the lower and deletes it', () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(bottom)!, 4, 4, 0, 0, RED);
    setPixel(getBuffer(top)!, 4, 4, 1, 1, BLUE);

    expect(mergeDown().ok).toBe(true);
    expect(doc().sprite.layers).toHaveLength(1);
    expect(px(bottom, 0, 0)).toEqual([255, 0, 0, 255]); // kept
    expect(px(bottom, 1, 1)).toEqual([0, 0, 255, 255]); // merged in
    expect(doc().activeLayerId).toBe(doc().sprite.layers[0].id);
  });

  it('is one undo step that restores both layers and the lower pixels', () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(top)!, 4, 4, 1, 1, BLUE);
    mergeDown();
    expect(history().past).toHaveLength(1);

    history().undo();
    expect(doc().sprite.layers).toHaveLength(2);
    expect(px(bottom, 1, 1)[3]).toBe(0);
    expect(px(top, 1, 1)).toEqual([0, 0, 255, 255]);
    history().redo();
    expect(doc().sprite.layers).toHaveLength(1);
    expect(px(bottom, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it("applies the merged-in layer's opacity", () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(top)!, 4, 4, 2, 2, BLUE);
    setLayerOpacity(doc().activeLayerId, 0.5, 1);
    history().clear();
    mergeDown();
    const [, , b, a] = px(bottom, 2, 2);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(150);
  });

  it('a hidden layer merges as nothing and is just removed', () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(top)!, 4, 4, 1, 1, BLUE);
    setLayerVisible(doc().activeLayerId, false);
    history().clear();
    mergeDown();
    expect(doc().sprite.layers).toHaveLength(1);
    expect(px(bottom, 1, 1)[3]).toBe(0);
  });

  it('refuses the bottom layer, groups, and indexed sprites', () => {
    twoLayers();
    doc().setActiveLayer(doc().sprite.layers[0].id);
    expect(mergeDown()).toMatchObject({ ok: false, reason: 'no-layer-below' });

    doc().setActiveLayer(doc().sprite.layers[1].id);
    addGroup('G');
    const group = doc().sprite.layers.find((l) => l.kind === 'group')!;
    doc().setActiveLayer(group.id);
    expect(mergeDown()).toMatchObject({ ok: false, reason: 'not-raster' });

    const palette: Palette = { id: 'p', name: 'P', colors: [[0, 0, 0, 255], RED as never] };
    doc().newDocument(4, 4, 'indexed', palette);
    doc().addLayer('Top');
    expect(mergeDown()).toMatchObject({ ok: false, reason: 'indexed' });
  });

  it('refuses when the lower layer has linked cels', () => {
    twoLayers();
    const { frame, cels } = doc().createFrame();
    doc().insertFrame(frame, cels, 1);
    const lower = doc().sprite.layers[0];
    const [first, second] = doc().celsForLayer(lower.id);
    doc().setCelLink(second.id, first.id);
    expect(mergeDown()).toMatchObject({ ok: false, reason: 'linked-cels' });
    expect(doc().sprite.layers).toHaveLength(2);
  });

  it('finds the layer below among siblings only', () => {
    twoLayers();
    const [a, b] = doc().sprite.layers;
    expect(layerBelow(doc().sprite, b)?.id).toBe(a.id);
    expect(layerBelow(doc().sprite, a)).toBeUndefined();
  });
});

describe('flattenLayers', () => {
  it('composites every layer into one, honouring order', () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(bottom)!, 4, 4, 0, 0, RED);
    setPixel(getBuffer(top)!, 4, 4, 0, 0, BLUE); // covers red
    setPixel(getBuffer(bottom)!, 4, 4, 3, 3, RED);

    expect(flattenLayers().ok).toBe(true);
    expect(doc().sprite.layers).toHaveLength(1);
    expect(doc().sprite.layers[0].name).toBe('Flattened');
    const only = doc().activeCel()!.id;
    expect(px(only, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(px(only, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('drops hidden layers', () => {
    const { bottom, top } = twoLayers();
    setPixel(getBuffer(bottom)!, 4, 4, 0, 0, RED);
    setPixel(getBuffer(top)!, 4, 4, 1, 1, BLUE);
    setLayerVisible(doc().activeLayerId, false);
    history().clear();
    flattenLayers();
    const only = doc().activeCel()!.id;
    expect(px(only, 1, 1)[3]).toBe(0);
    expect(px(only, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('keeps every frame, and undo brings every layer back', () => {
    const { bottom, top } = twoLayers();
    const { frame, cels } = doc().createFrame();
    doc().insertFrame(frame, cels, 1);
    history().clear();
    setPixel(getBuffer(top)!, 4, 4, 2, 2, BLUE);

    flattenLayers();
    expect(doc().sprite.frames).toHaveLength(2);
    expect(doc().sprite.cels).toHaveLength(2); // one layer × two frames

    history().undo();
    expect(doc().sprite.layers).toHaveLength(2);
    expect(px(top, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(getBuffer(bottom)).toBeDefined();
    expect(doc().sprite.cels).toHaveLength(4);
  });

  it('refuses a single layer and indexed sprites', () => {
    doc().newDocument(4, 4);
    expect(flattenLayers()).toMatchObject({ ok: false, reason: 'single-layer' });
  });
});
