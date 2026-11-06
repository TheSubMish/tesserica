import { beforeEach, describe, expect, it } from 'vitest';

import { getIndexBuffer } from '../model/indexBuffers';
import { getBuffer, setPixel } from '../model/pixelBuffers';
import { rectSelection } from '../model/selection';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useSelectionStore } from '../state/selectionStore';
import { cropToSelection, flipActiveLayer, resizeCanvas, transformSprite } from './spriteCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();
const RED = [255, 0, 0, 255] as const;

/** A `w×h` document with one opaque red pixel at (px, py). */
function setup(w: number, h: number, px: number, py: number) {
  doc().newDocument(w, h);
  history().clear();
  const cel = doc().activeCel()!;
  setPixel(getBuffer(cel.id)!, w, h, px, py, RED);
  return cel.id;
}

const alphaAt = (id: string, w: number, x: number, y: number) =>
  getBuffer(id)![(y * w + x) * 4 + 3];

beforeEach(() => {
  useSelectionStore.getState().clear();
});

describe('resizeCanvas', () => {
  it('grows with the anchor, keeping the pixel where the anchor says', () => {
    const id = setup(4, 4, 3, 3); // bottom-right pixel
    expect(resizeCanvas(8, 6, 'tl').ok).toBe(true);
    expect([doc().sprite.width, doc().sprite.height]).toEqual([8, 6]);
    expect(doc().sprite.cels.every((c) => c.width === 8 && c.height === 6)).toBe(true);
    expect(getBuffer(id)!.length).toBe(8 * 6 * 4);
    expect(alphaAt(id, 8, 3, 3)).toBe(255); // top-left anchor: unmoved
  });

  it('anchors bottom-right', () => {
    const id = setup(4, 4, 0, 0);
    resizeCanvas(8, 8, 'br');
    expect(alphaAt(id, 8, 4, 4)).toBe(255);
    expect(alphaAt(id, 8, 0, 0)).toBe(0);
  });

  it('undo and redo restore both the pixels and the sprite size', () => {
    const id = setup(4, 4, 1, 1);
    resizeCanvas(10, 10, 'c');
    history().undo();
    expect([doc().sprite.width, doc().sprite.height]).toEqual([4, 4]);
    expect(getBuffer(id)!.length).toBe(4 * 4 * 4);
    expect(alphaAt(id, 4, 1, 1)).toBe(255);
    history().redo();
    expect(doc().sprite.width).toBe(10);
    expect(getBuffer(id)!.length).toBe(10 * 10 * 4);
  });

  it('a stroke after redo cannot corrupt the stored snapshot', () => {
    const id = setup(4, 4, 1, 1);
    resizeCanvas(6, 6, 'tl');
    history().undo();
    history().redo();
    setPixel(getBuffer(id)!, 6, 6, 5, 5, RED); // paint on the live buffer
    history().undo(); // undo the (untracked) paint is not recorded, so undo the resize
    history().redo();
    expect(alphaAt(id, 6, 5, 5)).toBe(0); // the snapshot, not the painted buffer
  });

  it('rejects a bad size and a no-op without touching history', () => {
    setup(4, 4, 0, 0);
    expect(resizeCanvas(0, 4, 'c')).toMatchObject({ ok: false, reason: 'invalid-size' });
    expect(resizeCanvas(4.5, 4, 'c')).toMatchObject({ ok: false, reason: 'invalid-size' });
    expect(resizeCanvas(5000, 4, 'c')).toMatchObject({ ok: false, reason: 'invalid-size' });
    expect(resizeCanvas(4, 4, 'c')).toMatchObject({ ok: false, reason: 'no-change' });
    expect(history().past).toHaveLength(0);
  });

  it('clears the selection', () => {
    setup(4, 4, 0, 0);
    useSelectionStore.getState().setSelection(rectSelection({ x: 0, y: 0, width: 2, height: 2 }));
    resizeCanvas(6, 6, 'c');
    expect(useSelectionStore.getState().selection).toBeNull();
  });
});

describe('cropToSelection', () => {
  it('crops to the selection bounds', () => {
    const id = setup(8, 8, 5, 4);
    useSelectionStore.getState().setSelection(rectSelection({ x: 4, y: 3, width: 3, height: 3 }));
    expect(cropToSelection().ok).toBe(true);
    expect([doc().sprite.width, doc().sprite.height]).toEqual([3, 3]);
    expect(alphaAt(id, 3, 1, 1)).toBe(255); // (5,4) − (4,3)
  });

  it('needs a selection', () => {
    setup(4, 4, 0, 0);
    expect(cropToSelection()).toMatchObject({ ok: false, reason: 'no-selection' });
  });

  it('clamps a selection that hangs off the canvas', () => {
    setup(4, 4, 3, 3);
    useSelectionStore.getState().setSelection(rectSelection({ x: 2, y: 2, width: 10, height: 10 }));
    cropToSelection();
    expect([doc().sprite.width, doc().sprite.height]).toEqual([2, 2]);
  });
});

describe('transformSprite', () => {
  it('flips horizontally, and undo restores', () => {
    const id = setup(4, 2, 0, 0);
    transformSprite('flip-h');
    expect(alphaAt(id, 4, 3, 0)).toBe(255);
    expect(alphaAt(id, 4, 0, 0)).toBe(0);
    history().undo();
    expect(alphaAt(id, 4, 0, 0)).toBe(255);
  });

  it('rotating 90° swaps the sprite dimensions and moves the pixel', () => {
    const id = setup(4, 2, 0, 0); // top-left of a 4×2
    transformSprite('rot-cw');
    expect([doc().sprite.width, doc().sprite.height]).toEqual([2, 4]);
    expect(alphaAt(id, 2, 1, 0)).toBe(255); // top-left → top-right
    history().undo();
    expect([doc().sprite.width, doc().sprite.height]).toEqual([4, 2]);
  });

  it("transforms a linked cel's shared buffer once", () => {
    const id = setup(4, 2, 0, 0);
    // A second frame whose cel links to the first.
    const { frame, cels } = doc().createFrame();
    doc().insertFrame(frame, cels, 1);
    const second = cels.find((c) => c.layerId === doc().activeLayerId)!;
    doc().setCelLink(second.id, id);
    history().clear();
    transformSprite('flip-h');
    expect(alphaAt(id, 4, 3, 0)).toBe(255);
    expect(alphaAt(id, 4, 0, 0)).toBe(0); // flipped once, not twice
  });

  it('is refused with a tilemap layer, and changes nothing', () => {
    const id = setup(4, 4, 0, 0);
    const tileset = { id: 'ts', name: 'T', tileWidth: 2, tileHeight: 2, tiles: [] };
    doc().insertTileset(tileset, 0);
    const made = doc().createTilemapLayer('ts', {
      shape: 'rect',
      tileWidth: 2,
      tileHeight: 2,
      offsetX: 0,
      offsetY: 0,
    });
    doc().insertLayer(made.layer, made.cels, doc().sprite.layers.length);
    history().clear();
    expect(transformSprite('flip-h')).toMatchObject({ ok: false, reason: 'tilemap-layers' });
    expect(resizeCanvas(8, 8, 'c')).toMatchObject({ ok: false, reason: 'tilemap-layers' });
    expect(alphaAt(id, 4, 0, 0)).toBe(255);
    expect(history().past).toHaveLength(0);
  });
});

describe('flipActiveLayer', () => {
  it('flips only the active layer', () => {
    const first = setup(4, 2, 0, 0);
    doc().addLayer('Top');
    history().clear();
    const top = doc().activeCel()!.id;
    setPixel(getBuffer(top)!, 4, 2, 0, 0, RED);
    expect(flipActiveLayer('h').ok).toBe(true);
    expect(alphaAt(top, 4, 3, 0)).toBe(255);
    expect(alphaAt(first, 4, 0, 0)).toBe(255); // the layer below is untouched
  });

  it('refuses a group layer', () => {
    setup(4, 4, 0, 0);
    const made = doc().createGroup('G');
    doc().insertLayer(made.layer, made.cels, doc().sprite.layers.length);
    doc().setActiveLayer(made.layer.id);
    expect(flipActiveLayer('v')).toMatchObject({ ok: false, reason: 'not-raster' });
  });
});

describe('indexed sprites', () => {
  const palette: Palette = {
    id: 'p',
    name: 'P',
    colors: [
      [0, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  it('transforms index buffers directly and leaves the palette alone', () => {
    doc().newDocument(3, 2, 'indexed', palette);
    history().clear();
    const id = doc().activeCel()!.id;
    getIndexBuffer(id)![0] = 2; // top-left = palette entry 2
    transformSprite('flip-h');
    expect(getIndexBuffer(id)![2]).toBe(2);
    expect(getIndexBuffer(id)![0]).toBe(0);
    expect(doc().sprite.palette).toEqual(palette);
    resizeCanvas(5, 2, 'tl');
    expect(getIndexBuffer(id)!.length).toBe(10);
  });
});
