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

  it('addCustomColor creates the Custom palette on first use and selects it', () => {
    expect(store().palettes.some((p) => p.id === 'custom')).toBe(false);

    store().addCustomColor([255, 0, 170, 255]);

    const active = store().activePalette();
    expect(active).toEqual({
      id: 'custom',
      name: 'Custom',
      colors: [[255, 0, 170, 255]],
      source: { kind: 'custom' },
    });
  });

  it('addCustomColor appends to an existing Custom palette without touching other palettes', () => {
    const before = store().palettes.find((p) => p.id !== 'custom');
    store().addCustomColor([0, 255, 0, 255]);

    expect(store().activePalette().colors).toEqual([
      [255, 0, 170, 255],
      [0, 255, 0, 255],
    ]);
    // Every other palette is untouched.
    expect(store().palettes.find((p) => p.id === before?.id)).toEqual(before);
  });

  it('addCustomColor is a no-op on an exact duplicate, but still selects Custom', () => {
    store().setActivePalette('cga');
    store().addCustomColor([255, 0, 170, 255]);

    expect(store().activePaletteId).toBe('custom');
    expect(store().activePalette().colors).toHaveLength(2);
  });

  it('removeCustomColor drops one swatch by index and leaves the rest in order', () => {
    store().removeCustomColor(0);
    expect(store().activePalette().colors).toEqual([[0, 255, 0, 255]]);
  });

  it('removeCustomColor on a missing Custom palette is a no-op', () => {
    usePaletteStore.setState({
      palettes: usePaletteStore.getState().palettes.filter((p) => p.id !== 'custom'),
    });
    expect(() => store().removeCustomColor(0)).not.toThrow();
  });
});
