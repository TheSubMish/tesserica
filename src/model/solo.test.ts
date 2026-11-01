import { describe, expect, it } from 'vitest';

import type { Layer, Sprite } from './types';
import { withSolo } from './solo';

const layer = (id: string, parentId: string | null, over: Partial<Layer> = {}): Layer =>
  ({
    id,
    name: id,
    kind: id.startsWith('g') ? 'group' : 'raster',
    ...(id.startsWith('g') ? { collapsed: false } : {}),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId,
    clippingMask: false,
    effects: [],
    ...over,
  }) as Layer;

const sprite = (layers: Layer[]): Sprite => ({
  width: 2,
  height: 2,
  colorMode: 'rgba',
  layers,
  frames: [],
  cels: [],
  tags: [],
  tilesets: [],
});

const visible = (s: Sprite) => Object.fromEntries(s.layers.map((l) => [l.id, l.visible]));

describe('withSolo', () => {
  it('is the same object when nothing is soloed or the layer is gone', () => {
    const s = sprite([layer('a', null), layer('b', null)]);
    expect(withSolo(s, null)).toBe(s);
    expect(withSolo(s, 'missing')).toBe(s);
  });

  it('shows only the soloed layer', () => {
    const s = sprite([layer('a', null), layer('b', null), layer('c', null)]);
    expect(visible(withSolo(s, 'b'))).toEqual({ a: false, b: true, c: false });
  });

  it('shows a soloed layer even if it is hidden', () => {
    const s = sprite([layer('a', null), layer('b', null, { visible: false })]);
    expect(visible(withSolo(s, 'b')).b).toBe(true);
  });

  it('keeps ancestor groups visible, and hides their other children', () => {
    const s = sprite([layer('g1', null), layer('a', 'g1'), layer('b', 'g1'), layer('c', null)]);
    expect(visible(withSolo(s, 'a'))).toEqual({ g1: true, a: true, b: false, c: false });
  });

  it('a soloed group keeps its children as they were', () => {
    const s = sprite([
      layer('g1', null),
      layer('a', 'g1'),
      layer('b', 'g1', { visible: false }),
      layer('c', null),
    ]);
    expect(visible(withSolo(s, 'g1'))).toEqual({ g1: true, a: true, b: false, c: false });
  });

  it('never mutates the original sprite', () => {
    const s = sprite([layer('a', null), layer('b', null)]);
    withSolo(s, 'a');
    expect(visible(s)).toEqual({ a: true, b: true });
  });
});
