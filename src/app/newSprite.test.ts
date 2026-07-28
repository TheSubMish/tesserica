import { describe, expect, it } from 'vitest';
import { getBuffer } from '../model/pixelBuffers';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { usePaletteStore } from '../state/paletteStore';
import { useUIStore } from '../state/uiStore';
import { createNewSprite, MAX_SPRITE_SIZE, MIN_SPRITE_SIZE } from './newSprite';

describe('createNewSprite', () => {
  it('replaces the document with a single blank raster layer at the requested size', () => {
    createNewSprite({ width: 32, height: 16 });

    const doc = useDocumentStore.getState();
    expect([doc.sprite.width, doc.sprite.height]).toEqual([32, 16]);
    expect(doc.sprite.layers).toHaveLength(1);
    expect(doc.sprite.layers[0].kind).toBe('raster');

    const cel = doc.sprite.cels[0];
    expect(getBuffer(cel.id)?.every((v) => v === 0)).toBe(true);
  });

  it('clamps to the sane size bound rather than trusting a fat-fingered field', () => {
    createNewSprite({ width: 0, height: MAX_SPRITE_SIZE + 500 });
    const { width, height } = useDocumentStore.getState().sprite;
    expect(width).toBe(MIN_SPRITE_SIZE);
    expect(height).toBe(MAX_SPRITE_SIZE);
  });

  it('clears the project path — a new sprite has never been saved', () => {
    useDocumentStore.getState().setProjectPath('/tmp/old.tess');
    createNewSprite({ width: 8, height: 8 });
    expect(useDocumentStore.getState().projectPath).toBeNull();
  });

  it('drops undo history from the replaced document', () => {
    createNewSprite({ width: 8, height: 8 });
    useHistoryStore.getState().push({
      label: 'test',
      memoryCost: 1,
      apply: (_doc) => {},
      invert: (_doc) => {},
    });
    expect(useHistoryStore.getState().past).toHaveLength(1);

    createNewSprite({ width: 8, height: 8 });
    expect(useHistoryStore.getState().past).toHaveLength(0);
    expect(useHistoryStore.getState().future).toHaveLength(0);
  });

  it('switches to Edit mode — W2 is Edit-only', () => {
    useUIStore.getState().setMode('convert');
    createNewSprite({ width: 8, height: 8 });
    expect(useUIStore.getState().mode).toBe('edit');
  });

  it('requests a viewport re-fit so the new sprite opens centered', () => {
    const before = useUIStore.getState().fitRequest;
    createNewSprite({ width: 8, height: 8 });
    expect(useUIStore.getState().fitRequest).toBeGreaterThan(before);
  });

  it('makes the chosen palette active when one is supplied', () => {
    const target = usePaletteStore.getState().palettes[1].id;
    createNewSprite({ width: 8, height: 8, paletteId: target });
    expect(usePaletteStore.getState().activePaletteId).toBe(target);
  });

  it('leaves the active palette alone when none is supplied', () => {
    const target = usePaletteStore.getState().palettes[2].id;
    usePaletteStore.getState().setActivePalette(target);
    createNewSprite({ width: 8, height: 8 });
    expect(usePaletteStore.getState().activePaletteId).toBe(target);
  });
});
