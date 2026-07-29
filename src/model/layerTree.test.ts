import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  childrenOf,
  depthOf,
  descendantIds,
  isEffectivelyLocked,
  isEffectivelyVisible,
  visibleLayerRows,
  wouldCreateCycle,
} from './layerTree';
import type { Layer, LayerBase } from './types';

// Overrides are typed `Partial<LayerBase>`, not `Partial<Layer>`: the latter
// widens `kind` back to the whole union and stops the literal narrowing.
function raster(id: string, parentId: string | null, over: Partial<LayerBase> = {}): Layer {
  return {
    id,
    kind: 'raster',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId,
    clippingMask: false,
    ...over,
  };
}

function group(id: string, parentId: string | null, over: Partial<LayerBase> = {}): Layer {
  return {
    id,
    kind: 'group',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId,
    clippingMask: false,
    collapsed: false,
    ...over,
  };
}

// bg (top level), G (top level) [ A, B [ C ] ] — B is a group nested in G.
const layers: Layer[] = [
  raster('bg', null),
  group('G', null),
  raster('A', 'G'),
  group('B', 'G'),
  raster('C', 'B'),
];

describe('childrenOf', () => {
  it('returns direct members only, in flat-array order', () => {
    expect(childrenOf(layers, null).map((l) => l.id)).toEqual(['bg', 'G']);
    expect(childrenOf(layers, 'G').map((l) => l.id)).toEqual(['A', 'B']);
    expect(childrenOf(layers, 'B').map((l) => l.id)).toEqual(['C']);
  });

  it('does not require contiguity with the parent', () => {
    // Interleave a top-level layer between two children of G — membership is
    // still purely by `parentId`, not by array position.
    const interleaved: Layer[] = [
      group('G', null),
      raster('A', 'G'),
      raster('other', null),
      raster('B2', 'G'),
    ];
    expect(childrenOf(interleaved, null).map((l) => l.id)).toEqual(['G', 'other']);
    expect(childrenOf(interleaved, 'G').map((l) => l.id)).toEqual(['A', 'B2']);
  });
});

describe('descendantIds', () => {
  it('walks every depth', () => {
    expect(new Set(descendantIds(layers, 'G'))).toEqual(new Set(['A', 'B', 'C']));
    expect(descendantIds(layers, 'B')).toEqual(['C']);
    expect(descendantIds(layers, 'bg')).toEqual([]);
  });
});

describe('ancestorsOf / depthOf', () => {
  it('returns the chain immediate-parent-first', () => {
    expect(ancestorsOf(layers, 'C').map((l) => l.id)).toEqual(['B', 'G']);
    expect(ancestorsOf(layers, 'bg')).toEqual([]);
  });

  it('depth is the ancestor count', () => {
    expect(depthOf(layers, 'bg')).toBe(0);
    expect(depthOf(layers, 'A')).toBe(1);
    expect(depthOf(layers, 'C')).toBe(2);
  });
});

describe('isEffectivelyVisible / isEffectivelyLocked', () => {
  it('inherits from every ancestor', () => {
    const hiddenGroup: Layer[] = [group('G', null, { visible: false }), raster('A', 'G')];
    expect(isEffectivelyVisible(hiddenGroup, 'A')).toBe(false);
    expect(isEffectivelyVisible(hiddenGroup, 'G')).toBe(false);

    const lockedGroup: Layer[] = [group('G', null, { locked: true }), raster('A', 'G')];
    expect(isEffectivelyLocked(lockedGroup, 'A')).toBe(true);
    expect(isEffectivelyLocked(lockedGroup, 'G')).toBe(true);
  });

  it('a plain visible/unlocked tree is unaffected', () => {
    expect(isEffectivelyVisible(layers, 'C')).toBe(true);
    expect(isEffectivelyLocked(layers, 'C')).toBe(false);
  });
});

describe('visibleLayerRows', () => {
  it('lists top-of-stack first with each group’s children indented beneath it', () => {
    // layers = [bg, G[A, B[C]]] in bottom→top storage order.
    const rows = visibleLayerRows(layers);
    expect(rows.map((r) => [r.layer.id, r.depth])).toEqual([
      ['G', 0],
      ['B', 1],
      ['C', 2],
      ['A', 1],
      ['bg', 0],
    ]);
  });

  it('omits a collapsed group’s children entirely', () => {
    const g: Layer = { ...(group('G', null) as Layer & { kind: 'group' }), collapsed: true };
    const collapsed: Layer[] = [g, raster('A', 'G')];
    expect(visibleLayerRows(collapsed).map((r) => r.layer.id)).toEqual(['G']);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects nesting a group inside its own descendant', () => {
    expect(wouldCreateCycle(layers, 'G', 'B')).toBe(true);
    expect(wouldCreateCycle(layers, 'B', 'G')).toBe(false);
  });

  it('rejects self-parenting', () => {
    expect(wouldCreateCycle(layers, 'G', 'G')).toBe(true);
  });

  it('allows top level and unrelated groups', () => {
    expect(wouldCreateCycle(layers, 'A', null)).toBe(false);
    expect(wouldCreateCycle(layers, 'bg', 'G')).toBe(false);
  });
});
