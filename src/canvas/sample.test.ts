import { beforeEach, describe, expect, it } from 'vitest';
import { allocateBuffer, setPixel } from '../model/pixelBuffers';
import { allocateIndexBuffer } from '../model/indexBuffers';
import { allocateGrid, setGridCell } from '../model/tileGridBuffers';
import { clearAllTileBuffers, setTileBuffer } from '../model/tileBuffers';
import { packTileId } from '../model/tileIds';
import type {
  Cel,
  Frame,
  GridSpec,
  Layer,
  LayerBase,
  Palette,
  Sprite,
  Tileset,
} from '../model/types';
import { compositeOver, samplePixel } from './sample';
import { picker } from '../tools/picker';
import { harness } from '../tools/testHarness';

function layer(id: string, over: Partial<LayerBase> = {}): Layer {
  return {
    id,
    kind: 'raster',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId: null,
    clippingMask: false,
    effects: [],
    ...over,
  };
}

function group(id: string, over: Partial<LayerBase> = {}): Layer {
  return {
    id,
    kind: 'group',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    parentId: null,
    clippingMask: false,
    effects: [],
    collapsed: false,
    ...over,
  };
}

function sprite(layers: Layer[], size = 4): { sprite: Sprite; frameId: string } {
  const frame: Frame = { id: 'f1', durationMs: 100 };
  // Groups have no pixels of their own — no cel to create for them.
  const cels: Cel[] = layers
    .filter((l) => l.kind !== 'group')
    .map((l) => ({
      id: `cel-${l.id}`,
      layerId: l.id,
      frameId: frame.id,
      x: 0,
      y: 0,
      width: size,
      height: size,
    }));
  cels.forEach((c) => allocateBuffer(c.id, size, size));
  return {
    sprite: {
      width: size,
      height: size,
      colorMode: 'rgba',
      layers,
      frames: [frame],
      cels,
      tags: [],
      tilesets: [],
    },
    frameId: frame.id,
  };
}

describe('compositeOver', () => {
  it('leaves an opaque source untouched', () => {
    expect(compositeOver([10, 20, 30, 255], 1, [200, 200, 200, 255])).toEqual([10, 20, 30, 255]);
  });

  it('shows the destination through a transparent source', () => {
    expect(compositeOver([10, 20, 30, 0], 1, [200, 200, 200, 255])).toEqual([200, 200, 200, 255]);
  });

  it('does not darken edges the way premultiplied maths would', () => {
    // A half-transparent white over transparent black stays white with half
    // alpha. Premultiplying would give a grey, which is the classic fringing
    // bug (docs/02-architecture.md §9).
    expect(compositeOver([255, 255, 255, 128], 1, [0, 0, 0, 0])).toEqual([255, 255, 255, 128]);
  });

  it('scales the source by layer opacity', () => {
    expect(compositeOver([0, 0, 0, 255], 0.5, [255, 255, 255, 255])).toEqual([128, 128, 128, 255]);
  });

  describe('blend modes', () => {
    it('multiplies an opaque source over an opaque backdrop', () => {
      expect(compositeOver([128, 128, 128, 255], 1, [255, 255, 255, 255], 'multiply')).toEqual([
        128, 128, 128, 255,
      ]);
    });

    it('falls back to the plain colour when the backdrop is fully transparent', () => {
      // No backdrop colour to blend against — Cs' collapses to Cs regardless
      // of mode, same as `normal`.
      expect(compositeOver([10, 20, 30, 255], 1, [0, 0, 0, 0], 'multiply')).toEqual([
        10, 20, 30, 255,
      ]);
    });

    it('screens an opaque white source to white regardless of backdrop', () => {
      expect(compositeOver([255, 255, 255, 255], 1, [10, 20, 30, 255], 'screen')).toEqual([
        255, 255, 255, 255,
      ]);
    });

    it('is unaffected by blend mode when the source itself is fully transparent', () => {
      expect(compositeOver([10, 20, 30, 0], 1, [200, 200, 200, 255], 'multiply')).toEqual([
        200, 200, 200, 255,
      ]);
    });
  });
});

describe('samplePixel', () => {
  it('returns the flattened colour, not the active layer', () => {
    const bottom = layer('a');
    const top = layer('b');
    const { sprite: s, frameId } = sprite([bottom, top]);
    setPixel(allocateBuffer('cel-a', 4, 4), 4, 4, 1, 1, [10, 200, 10, 255]);
    // Top layer is transparent there, so the green below must come through.
    expect(samplePixel(s, frameId, 1, 1)).toEqual([10, 200, 10, 255]);
  });

  it('skips hidden layers', () => {
    const bottom = layer('a');
    const top = layer('b', { visible: false });
    const { sprite: s, frameId } = sprite([bottom, top]);
    setPixel(allocateBuffer('cel-a', 4, 4), 4, 4, 0, 0, [1, 2, 3, 255]);
    setPixel(allocateBuffer('cel-b', 4, 4), 4, 4, 0, 0, [9, 9, 9, 255]);
    expect(samplePixel(s, frameId, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('returns null outside the sprite', () => {
    const { sprite: s, frameId } = sprite([layer('a')]);
    expect(samplePixel(s, frameId, -1, 0)).toBeNull();
    expect(samplePixel(s, frameId, 4, 0)).toBeNull();
  });
});

describe('groups', () => {
  it('composites children as a unit, then applies the group’s own opacity', () => {
    const bg = layer('bg');
    const g = group('g', { opacity: 0.5 });
    const child = layer('child', { parentId: 'g' });
    const { sprite: s, frameId } = sprite([bg, g, child]);

    setPixel(allocateBuffer('cel-bg', 4, 4), 4, 4, 0, 0, [255, 0, 0, 255]);
    setPixel(allocateBuffer('cel-child', 4, 4), 4, 4, 0, 0, [0, 0, 255, 255]);

    // Half-opacity blue over opaque red — 50/50, not blue's own alpha diluted
    // by the child's un-applied opacity.
    expect(samplePixel(s, frameId, 0, 0)).toEqual([128, 0, 128, 255]);
  });

  it('hides every descendant when the group itself is hidden', () => {
    const g = group('g', { visible: false });
    const child = layer('child', { parentId: 'g' });
    const { sprite: s, frameId } = sprite([g, child]);
    setPixel(allocateBuffer('cel-child', 4, 4), 4, 4, 0, 0, [1, 2, 3, 255]);

    expect(samplePixel(s, frameId, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('clipping masks', () => {
  it('shows a clipped layer only where the base below has its own alpha', () => {
    const base = layer('base');
    const clip = layer('clip', { clippingMask: true });
    const { sprite: s, frameId } = sprite([base, clip]);

    // Base is opaque red at (0,0), fully transparent at (1,1).
    setPixel(allocateBuffer('cel-base', 4, 4), 4, 4, 0, 0, [255, 0, 0, 255]);
    // Clip layer is opaque blue everywhere.
    const clipBuf = allocateBuffer('cel-clip', 4, 4);
    setPixel(clipBuf, 4, 4, 0, 0, [0, 0, 255, 255]);
    setPixel(clipBuf, 4, 4, 1, 1, [0, 0, 255, 255]);

    expect(samplePixel(s, frameId, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(samplePixel(s, frameId, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('contributes nothing when there is no base to clip to', () => {
    const clip = layer('clip', { clippingMask: true });
    const { sprite: s, frameId } = sprite([clip]);
    setPixel(allocateBuffer('cel-clip', 4, 4), 4, 4, 0, 0, [9, 9, 9, 255]);

    expect(samplePixel(s, frameId, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('never crosses a group boundary', () => {
    // A clip layer inside a group must not reach past the group's own edge
    // to a layer sitting below the group at the top level.
    const outerBase = layer('outerBase');
    const g = group('g');
    const innerClip = layer('innerClip', { parentId: 'g', clippingMask: true });
    const { sprite: s, frameId } = sprite([outerBase, g, innerClip]);

    setPixel(allocateBuffer('cel-outerBase', 4, 4), 4, 4, 0, 0, [255, 0, 0, 255]);
    setPixel(allocateBuffer('cel-innerClip', 4, 4), 4, 4, 0, 0, [0, 0, 255, 255]);

    // Nothing inside the group to clip to, so the clip layer contributes
    // nothing; the group is otherwise empty, so only the outer base shows.
    expect(samplePixel(s, frameId, 0, 0)).toEqual([255, 0, 0, 255]);
  });
});

describe('samplePixel on a tilemap layer (roadmap Phase 6)', () => {
  beforeEach(() => {
    clearAllTileBuffers();
  });

  it('reads the resolved (flipped) tile pixel, matching flatten/renderer', () => {
    const frame: Frame = { id: 'f1', durationMs: 100 };
    setTileBuffer(
      'tile-corner',
      new Uint8ClampedArray([
        255,
        0,
        0,
        255,
        0,
        255,
        0,
        255, //
        0,
        0,
        255,
        255,
        255,
        255,
        255,
        255,
      ]),
    );
    const tileset: Tileset = {
      id: 'ts1',
      name: 'Ground',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'tile-corner' }],
    };
    const grid: GridSpec = { shape: 'rect', tileWidth: 2, tileHeight: 2, offsetX: 0, offsetY: 0 };
    const tilemapLayer: Layer = {
      id: 'tm',
      kind: 'tilemap',
      name: 'tiles',
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      parentId: null,
      clippingMask: false,
      effects: [],
      tilesetId: 'ts1',
      grid,
    };
    const cel: Cel = {
      id: 'cel-tm',
      layerId: 'tm',
      frameId: 'f1',
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    };
    const gridBuf = allocateGrid(cel.id, 2, 2);
    setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1, { flipV: true }));

    const s: Sprite = {
      width: 4,
      height: 4,
      colorMode: 'rgba',
      layers: [tilemapLayer],
      frames: [frame],
      cels: [cel],
      tags: [],
      tilesets: [tileset],
    };

    // flipV: TL becomes old BL (blue), TR becomes old BR (white).
    expect(samplePixel(s, 'f1', 0, 0)).toEqual([0, 0, 255, 255]);
    expect(samplePixel(s, 'f1', 1, 0)).toEqual([255, 255, 255, 255]);
    // The never-painted bottom-right 2x2 cell is transparent.
    expect(samplePixel(s, 'f1', 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('eyedropper', () => {
  it('assigns to primary on the left button and secondary on the right', () => {
    const c = harness();
    c.sampleSource = () => [7, 8, 9, 255];

    picker.onPointerDown(c, 1, 1);
    expect(c.picked[c.picked.length - 1]).toEqual({ color: [7, 8, 9, 255], slot: 'primary' });

    c.button = 2;
    picker.onPointerDown(c, 1, 1);
    expect(c.picked[c.picked.length - 1]).toEqual({ color: [7, 8, 9, 255], slot: 'secondary' });
  });

  it('is read-only, so it makes no undo step', () => {
    expect(picker.readOnly).toBe(true);
  });

  it('ignores a sample outside the sprite', () => {
    const c = harness();
    c.sampleSource = () => null;
    picker.onPointerDown(c, 99, 99);
    expect(c.picked).toHaveLength(0);
  });
});

describe('samplePixel — indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  const palette: Palette = {
    id: 'p1',
    name: 'P',
    colors: [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ],
  };

  function indexedSprite(): { sprite: Sprite; frameId: string } {
    const frame: Frame = { id: 'f1', durationMs: 100 };
    const l = layer('l1');
    const cel: Cel = {
      id: 'cel-l1',
      layerId: 'l1',
      frameId: frame.id,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    };
    allocateIndexBuffer(cel.id, 4, 4).set([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    return {
      sprite: {
        width: 4,
        height: 4,
        colorMode: 'indexed',
        layers: [l],
        frames: [frame],
        cels: [cel],
        tags: [],
        tilesets: [],
        palette,
      },
      frameId: frame.id,
    };
  }

  it('resolves the stored index through the palette', () => {
    const { sprite, frameId } = indexedSprite();
    expect(samplePixel(sprite, frameId, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(samplePixel(sprite, frameId, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(samplePixel(sprite, frameId, 2, 0)).toEqual([0, 0, 0, 0]); // TRANSPARENT_INDEX
  });

  it('reflects a live palette swap without touching the stored index', () => {
    const { sprite, frameId } = indexedSprite();
    expect(samplePixel(sprite, frameId, 0, 0)).toEqual([255, 0, 0, 255]);
    const recolored: Sprite = {
      ...sprite,
      palette: { ...palette, colors: [[9, 9, 9, 255], palette.colors[1]] },
    };
    expect(samplePixel(recolored, frameId, 0, 0)).toEqual([9, 9, 9, 255]);
  });
});
