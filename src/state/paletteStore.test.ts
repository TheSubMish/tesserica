import { describe, expect, it } from 'vitest';
import type { Palette } from '../model/types';
import { usePaletteStore } from './paletteStore';

const store = () => usePaletteStore.getState();

const custom = (id: string): Palette => ({
  id,
  name: id,
  colors: [[1, 2, 3, 255]],
  source: { kind: 'file' },
});

describe('paletteStore', () => {
  it('starts on a bundled palette', () => {
    expect(store().activePalette().source).toEqual({ kind: 'builtin' });
  });

  it('selects an existing palette and ignores an unknown id', () => {
    store().setActivePalette('cga');
    expect(store().activePalette().id).toBe('cga');

    store().setActivePalette('does-not-exist');
    expect(store().activePalette().id).toBe('cga');
  });

  it('adds an imported palette and selects it', () => {
    const id = store().addPalette(custom('mine'));
    expect(id).toBe('mine');
    expect(store().activePalette().id).toBe('mine');
  });

  it('suffixes a colliding id rather than shadowing the first copy', () => {
    store().addPalette(custom('twice'));
    const second = store().addPalette(custom('twice'));
    expect(second).toBe('twice-2');
    expect(store().palettes.filter((p) => p.id.startsWith('twice'))).toHaveLength(2);
  });
});
