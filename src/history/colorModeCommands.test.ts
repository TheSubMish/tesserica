import { beforeEach, describe, expect, it } from 'vitest';
import { getBuffer, setPixel } from '../model/pixelBuffers';
import { getIndexBuffer } from '../model/indexBuffers';
import { celBufferId, type Palette } from '../model/types';
import { defaultSettings } from '../pipeline/settings';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { linkCel } from './frameCommands';
import { convertSpriteToIndexed } from './colorModeCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

const palette: Palette = {
  id: 'p',
  name: 'P',
  colors: [
    [255, 0, 0, 255], // 0 -> index 1
    [0, 255, 0, 255], // 1 -> index 2
  ],
};

beforeEach(() => {
  history().clear();
  doc().newDocument(4, 4);
  doc().setActiveLayer(doc().sprite.layers[0].id);
});

describe('convertSpriteToIndexed', () => {
  it('snaps every pixel of a raster cel to the nearest palette index and flips colorMode', () => {
    const cel = doc().activeCel()!;
    const buf = getBuffer(cel.id)!;
    setPixel(buf, 4, 4, 0, 0, [255, 0, 0, 255]); // exact match -> index 1
    setPixel(buf, 4, 4, 1, 0, [250, 5, 5, 255]); // near RED, not exact -> index 1
    setPixel(buf, 4, 4, 2, 0, [0, 255, 0, 255]); // exact GREEN -> index 2
    setPixel(buf, 4, 4, 3, 0, [10, 10, 10, 0]); // alpha 0 -> TRANSPARENT_INDEX (0)
    doc().touch(cel.id);

    const result = convertSpriteToIndexed(palette);
    expect(result.ok).toBe(true);

    expect(doc().sprite.colorMode).toBe('indexed');
    expect(doc().sprite.palette?.colors).toEqual(palette.colors);
    expect(doc().sprite.palette).not.toBe(palette); // embedded copy, not a live reference

    const idx = getIndexBuffer(cel.id)!;
    expect(idx[0]).toBe(1);
    expect(idx[1]).toBe(1);
    expect(idx[2]).toBe(2);
    expect(idx[3]).toBe(0);
    expect(getBuffer(cel.id)).toBeUndefined(); // moved out of the RGBA store
  });

  it('converts every raster layer, not just the active one', () => {
    doc().addLayer('two');
    const l2 = doc().sprite.layers[1];
    const cel2 = doc().celFor(l2.id, doc().activeFrameId)!;
    const buf2 = getBuffer(cel2.id)!;
    setPixel(buf2, 4, 4, 0, 0, [0, 255, 0, 255]);
    doc().touch(cel2.id);

    convertSpriteToIndexed(palette);
    expect(getIndexBuffer(cel2.id)?.[0]).toBe(2);
  });

  it('leaves a conversion layer RGBA while the rest of the sprite goes indexed', () => {
    const convLayer = {
      id: 'convL',
      kind: 'conversion' as const,
      name: 'Converted',
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal' as const,
      parentId: null,
      clippingMask: false,
      effects: [],
      source: { sourceId: 1, settings: defaultSettings(4, 4, { kind: 'auto', maxColors: 8 }) },
    };
    const convCel = {
      id: 'convC',
      layerId: convLayer.id,
      frameId: doc().activeFrameId,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    };
    doc().insertLayer(convLayer, [convCel], doc().sprite.layers.length);
    const convBuf = getBuffer(convCel.id)!;
    setPixel(convBuf, 4, 4, 0, 0, [1, 2, 3, 255]); // deliberately not in the palette
    doc().touch(convCel.id);

    const result = convertSpriteToIndexed(palette);
    expect(result.ok).toBe(true);
    expect(doc().sprite.colorMode).toBe('indexed');

    // The conversion layer's own cel is untouched: still RGBA, still its own pixels.
    expect(getIndexBuffer(convCel.id)).toBeUndefined();
    const stillRgba = getBuffer(convCel.id)!;
    expect([stillRgba[0], stillRgba[1], stillRgba[2], stillRgba[3]]).toEqual([1, 2, 3, 255]);
  });

  it('converts a shared (linked) buffer exactly once', () => {
    const cel1 = doc().activeCel()!;
    const layerId = cel1.layerId;
    const buf1 = getBuffer(cel1.id)!;
    setPixel(buf1, 4, 4, 0, 0, [0, 255, 0, 255]);
    doc().touch(cel1.id);

    const { frame, cels } = doc().createFrame();
    doc().insertFrame(frame, cels, doc().sprite.frames.length);
    const cel2 = cels.find((c) => c.layerId === layerId)!;
    linkCel(cel2.id, cel1.id);

    convertSpriteToIndexed(palette);
    // celBufferId(cel2) resolves to cel1.id — only one conversion happened,
    // and the shared buffer reflects it.
    expect(celBufferId(doc().sprite.cels.find((c) => c.id === cel2.id)!)).toBe(cel1.id);
    expect(getIndexBuffer(cel1.id)?.[0]).toBe(2);
  });

  it('is undoable: restores the exact original RGBA bytes and colorMode', () => {
    const cel = doc().activeCel()!;
    const buf = getBuffer(cel.id)!;
    setPixel(buf, 4, 4, 0, 0, [250, 5, 5, 255]);
    doc().touch(cel.id);
    const before = new Uint8ClampedArray(getBuffer(cel.id)!);

    convertSpriteToIndexed(palette);
    expect(history().past).toHaveLength(1);
    expect(history().past[0].label).toBe('Convert to Indexed');

    history().undo();
    expect(doc().sprite.colorMode).toBe('rgba');
    expect(doc().sprite.palette).toBeUndefined();
    expect(getIndexBuffer(cel.id)).toBeUndefined();
    expect([...getBuffer(cel.id)!]).toEqual([...before]);

    history().redo();
    expect(doc().sprite.colorMode).toBe('indexed');
    expect(getIndexBuffer(cel.id)?.[0]).toBe(1);
  });

  it('refuses an already-indexed sprite', () => {
    doc().newDocument(4, 4, 'indexed', palette);
    history().clear();
    const result = convertSpriteToIndexed(palette);
    expect(result).toEqual({ ok: false, reason: 'already-indexed' });
    expect(history().past).toHaveLength(0);
  });

  it('refuses an empty palette', () => {
    const result = convertSpriteToIndexed({ id: 'e', name: 'Empty', colors: [] });
    expect(result).toEqual({ ok: false, reason: 'empty-palette' });
    expect(history().past).toHaveLength(0);
  });
});
