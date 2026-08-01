import { beforeEach, describe, expect, it } from 'vitest';
import type { Palette } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { assignSpritePalette, recolorSpritePaletteEntry } from './paletteCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

const paletteA: Palette = {
  id: 'a',
  name: 'A',
  colors: [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ],
};
const paletteB: Palette = {
  id: 'b',
  name: 'B',
  colors: [
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ],
};

beforeEach(() => {
  history().clear();
  doc().newDocument(4, 4, 'indexed', paletteA);
  history().clear();
});

describe('assignSpritePalette', () => {
  it('swaps the sprite palette and undoes/redoes', () => {
    assignSpritePalette(paletteB);
    expect(doc().sprite.palette?.id).toBe('b');

    history().undo();
    expect(doc().sprite.palette?.id).toBe('a');

    history().redo();
    expect(doc().sprite.palette?.id).toBe('b');
  });

  it('embeds a copy, not a live reference', () => {
    assignSpritePalette(paletteB);
    expect(doc().sprite.palette).not.toBe(paletteB);
    expect(doc().sprite.palette?.colors).not.toBe(paletteB.colors);
    expect(doc().sprite.palette?.colors).toEqual(paletteB.colors);
  });
});

describe('recolorSpritePaletteEntry', () => {
  it('replaces one swatch colour without touching the others', () => {
    recolorSpritePaletteEntry(0, [10, 20, 30, 255]);
    const s = doc().sprite;
    expect(s.palette?.colors[0]).toEqual([10, 20, 30, 255]);
    expect(s.palette?.colors[1]).toEqual([0, 255, 0, 255]);
  });

  it('undoes back to the original colour', () => {
    recolorSpritePaletteEntry(0, [10, 20, 30, 255]);
    history().undo();
    expect(doc().sprite.palette?.colors[0]).toEqual([255, 0, 0, 255]);
  });

  it('coalesces consecutive edits to the same swatch into one undo step', () => {
    recolorSpritePaletteEntry(0, [1, 1, 1, 255]);
    recolorSpritePaletteEntry(0, [2, 2, 2, 255]);
    recolorSpritePaletteEntry(0, [3, 3, 3, 255]);

    expect(doc().sprite.palette?.colors[0]).toEqual([3, 3, 3, 255]);
    history().undo();
    // One coalesced step back to the pre-drag colour, not three separate steps.
    expect(doc().sprite.palette?.colors[0]).toEqual([255, 0, 0, 255]);
  });

  it('editing different swatches does not coalesce', () => {
    recolorSpritePaletteEntry(0, [1, 1, 1, 255]);
    recolorSpritePaletteEntry(1, [2, 2, 2, 255]);

    history().undo();
    expect(doc().sprite.palette?.colors[1]).toEqual([0, 255, 0, 255]);
    expect(doc().sprite.palette?.colors[0]).toEqual([1, 1, 1, 255]);

    history().undo();
    expect(doc().sprite.palette?.colors[0]).toEqual([255, 0, 0, 255]);
  });

  it('is a no-op for an out-of-range index or a missing palette', () => {
    recolorSpritePaletteEntry(99, [1, 1, 1, 255]);
    expect(history().past).toHaveLength(0);

    doc().newDocument(4, 4); // rgba, no palette
    history().clear();
    recolorSpritePaletteEntry(0, [1, 1, 1, 255]);
    expect(history().past).toHaveLength(0);
  });
});
