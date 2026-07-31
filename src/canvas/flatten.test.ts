import { beforeEach, describe, expect, it } from 'vitest';
import { allocateBuffer, clearAllBuffers, setPixel } from '../model/pixelBuffers';
import { allocateGrid, setGridCell } from '../model/tileGridBuffers';
import { clearAllTileBuffers, setTileBuffer } from '../model/tileBuffers';
import { packTileId } from '../model/tileIds';
import type { Cel, Frame, GridSpec, Layer, LayerBase, Sprite, Tileset } from '../model/types';
import { useUIStore } from '../state/uiStore';
import { flattenSprite } from './flatten';

const W = 4;
const H = 4;

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

function makeSprite(layers: Layer[], cels?: Partial<Cel>[]): Sprite {
  const frame: Frame = { id: 'f1', durationMs: 100 };
  // Groups have no pixels of their own — no cel to create for them.
  const list: Cel[] = layers
    .filter((l) => l.kind !== 'group')
    .map((l, i) => ({
      id: `cel-${l.id}`,
      layerId: l.id,
      frameId: frame.id,
      x: 0,
      y: 0,
      width: W,
      height: H,
      ...(cels?.[i] ?? {}),
    }));
  for (const c of list) allocateBuffer(c.id, c.width, c.height);
  return {
    width: W,
    height: H,
    colorMode: 'rgba',
    layers,
    frames: [frame],
    cels: list,
    tags: [],
    tilesets: [],
  };
}

const px = (buf: Uint8ClampedArray, x: number, y: number) =>
  Array.from(buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

beforeEach(() => clearAllBuffers());

describe('flattenSprite', () => {
  it('is transparent for an empty document', () => {
    const sprite = makeSprite([layer('a')]);
    expect(flattenSprite(sprite, 'f1').every((v) => v === 0)).toBe(true);
  });

  it('draws upper layers over lower ones', () => {
    const sprite = makeSprite([layer('a'), layer('b')]);
    setPixel(allocateBuffer('cel-a', W, H), W, H, 1, 1, [255, 0, 0, 255]);
    setPixel(allocateBuffer('cel-b', W, H), W, H, 1, 1, [0, 0, 255, 255]);
    expect(px(flattenSprite(sprite, 'f1'), 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('skips hidden layers and zero-opacity layers', () => {
    const sprite = makeSprite([layer('a'), layer('b', { visible: false })]);
    setPixel(allocateBuffer('cel-a', W, H), W, H, 0, 0, [1, 2, 3, 255]);
    setPixel(allocateBuffer('cel-b', W, H), W, H, 0, 0, [9, 9, 9, 255]);
    expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('applies layer opacity', () => {
    const sprite = makeSprite([layer('a'), layer('b', { opacity: 0.5 })]);
    setPixel(allocateBuffer('cel-a', W, H), W, H, 2, 2, [0, 0, 0, 255]);
    setPixel(allocateBuffer('cel-b', W, H), W, H, 2, 2, [255, 255, 255, 255]);
    expect(px(flattenSprite(sprite, 'f1'), 2, 2)).toEqual([128, 128, 128, 255]);
  });

  it('keeps alpha straight — a lone half-transparent pixel is not darkened', () => {
    // The premultiplied round trip through a canvas would give a grey here.
    // Export must not do that (docs/02-architecture.md §9).
    const sprite = makeSprite([layer('a')]);
    setPixel(allocateBuffer('cel-a', W, H), W, H, 0, 0, [255, 255, 255, 128]);
    expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it('honours a bounded cel offset without writing outside the sprite', () => {
    const sprite = makeSprite([layer('a')], [{ x: 2, y: 2, width: 2, height: 2 }]);
    const buf = allocateBuffer('cel-a', 2, 2);
    setPixel(buf, 2, 2, 0, 0, [7, 7, 7, 255]);
    const out = flattenSprite(sprite, 'f1');
    expect(px(out, 2, 2)).toEqual([7, 7, 7, 255]);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(out).toHaveLength(W * H * 4);
  });

  it('composites a non-normal blend mode, not just plain source-over', () => {
    const sprite = makeSprite([layer('a'), layer('b', { blendMode: 'multiply' })]);
    setPixel(allocateBuffer('cel-a', W, H), W, H, 0, 0, [200, 100, 50, 255]);
    setPixel(allocateBuffer('cel-b', W, H), W, H, 0, 0, [128, 128, 128, 255]);
    // multiply(200/255, 128/255) * 255 ≈ 100.4 → rounds to 100, etc.
    expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([100, 50, 25, 255]);
  });

  it('clips a cel that hangs off the edge', () => {
    const sprite = makeSprite([layer('a')], [{ x: 3, y: 3, width: 4, height: 4 }]);
    const buf = allocateBuffer('cel-a', 4, 4);
    for (let i = 0; i < 16; i++) setPixel(buf, 4, 4, i % 4, (i / 4) | 0, [5, 5, 5, 255]);
    const out = flattenSprite(sprite, 'f1');
    expect(px(out, 3, 3)).toEqual([5, 5, 5, 255]);
    expect(out).toHaveLength(W * H * 4);
  });

  describe('groups', () => {
    it('composites children as a unit, then applies the group’s own opacity', () => {
      const sprite = makeSprite([
        layer('bg'),
        group('g', { opacity: 0.5 }),
        layer('child', { parentId: 'g' }),
      ]);
      setPixel(allocateBuffer('cel-bg', W, H), W, H, 0, 0, [255, 0, 0, 255]);
      setPixel(allocateBuffer('cel-child', W, H), W, H, 0, 0, [0, 0, 255, 255]);
      expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([128, 0, 128, 255]);
    });

    it('hides every descendant when the group itself is hidden', () => {
      const sprite = makeSprite([
        group('g', { visible: false }),
        layer('child', { parentId: 'g' }),
      ]);
      setPixel(allocateBuffer('cel-child', W, H), W, H, 0, 0, [1, 2, 3, 255]);
      expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([0, 0, 0, 0]);
    });
  });

  describe('clipping masks', () => {
    it('shows a clipped layer only where the base below has its own alpha', () => {
      const sprite = makeSprite([layer('base'), layer('clip', { clippingMask: true })]);
      setPixel(allocateBuffer('cel-base', W, H), W, H, 0, 0, [255, 0, 0, 255]);
      const clipBuf = allocateBuffer('cel-clip', W, H);
      setPixel(clipBuf, W, H, 0, 0, [0, 0, 255, 255]);
      setPixel(clipBuf, W, H, 1, 1, [0, 0, 255, 255]);

      const out = flattenSprite(sprite, 'f1');
      expect(px(out, 0, 0)).toEqual([0, 0, 255, 255]);
      expect(px(out, 1, 1)).toEqual([0, 0, 0, 0]);
    });

    it('contributes nothing when there is no base to clip to', () => {
      const sprite = makeSprite([layer('clip', { clippingMask: true })]);
      setPixel(allocateBuffer('cel-clip', W, H), W, H, 0, 0, [9, 9, 9, 255]);
      expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([0, 0, 0, 0]);
    });

    it('never crosses a group boundary', () => {
      const sprite = makeSprite([
        layer('outerBase'),
        group('g'),
        layer('innerClip', { parentId: 'g', clippingMask: true }),
      ]);
      setPixel(allocateBuffer('cel-outerBase', W, H), W, H, 0, 0, [255, 0, 0, 255]);
      setPixel(allocateBuffer('cel-innerClip', W, H), W, H, 0, 0, [0, 0, 255, 255]);
      expect(px(flattenSprite(sprite, 'f1'), 0, 0)).toEqual([255, 0, 0, 255]);
    });
  });

  describe('onion skinning is excluded from export', () => {
    // Onion-skin ghosts are a `CanvasView`/`renderer.ts` display overlay only
    // (`docs/08-roadmap.md` Phase 4). `flattenSprite` is the export path and
    // has no import of `uiStore` at all — this test is the regression
    // contract for that: whatever the onion-skin view state says, exporting
    // the very same sprite/frame must produce identical bytes.
    it('produces identical output regardless of onion-skin toggle or range', () => {
      const sprite = makeSprite([layer('l1')]);
      setPixel(allocateBuffer('cel-l1', W, H), W, H, 0, 0, [10, 20, 30, 255]);

      useUIStore.setState({ onionSkinEnabled: false, onionSkinBefore: 1, onionSkinAfter: 1 });
      const withoutOnionSkin = flattenSprite(sprite, 'f1');

      useUIStore.setState({ onionSkinEnabled: true, onionSkinBefore: 4, onionSkinAfter: 4 });
      const withOnionSkin = flattenSprite(sprite, 'f1');

      expect(Array.from(withOnionSkin)).toEqual(Array.from(withoutOnionSkin));
    });
  });

  describe('tilemap layers (roadmap Phase 6)', () => {
    beforeEach(() => {
      clearAllTileBuffers();
    });

    it('resolves a grid + tileset into pixels, pixel-exact including a flipped tile', () => {
      const frame: Frame = { id: 'f1', durationMs: 100 };
      // A 2x2 tile with four distinct corners: TL red, TR green, BL blue, BR white.
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
        width: W, // 4x4 sprite -> 2x2 grid of 2x2 tiles
        height: H,
      };
      const gridBuf = allocateGrid(cel.id, 2, 2);
      setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1)); // unflipped, top-left cell
      setGridCell(gridBuf, 2, 2, 1, 0, packTileId(1, { flipH: true })); // top-right cell, flipped

      const sprite: Sprite = {
        width: W,
        height: H,
        colorMode: 'rgba',
        layers: [tilemapLayer],
        frames: [frame],
        cels: [cel],
        tags: [],
        tilesets: [tileset],
      };

      const out = flattenSprite(sprite, 'f1');
      // Unflipped tile at (0,0): TL is red.
      expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
      expect(px(out, 1, 0)).toEqual([0, 255, 0, 255]);
      // Flipped tile at grid column 1 (document x=2..3): TL and TR swap.
      expect(px(out, 2, 0)).toEqual([0, 255, 0, 255]);
      expect(px(out, 3, 0)).toEqual([255, 0, 0, 255]);
      // Bottom-left 2x2 cell was never painted (tile id 0, empty) -> transparent.
      expect(px(out, 0, 2)).toEqual([0, 0, 0, 0]);
    });

    it('renders fully transparent when the referenced tileset is missing', () => {
      const frame: Frame = { id: 'f1', durationMs: 100 };
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
        tilesetId: 'missing-tileset',
        grid,
      };
      const cel: Cel = {
        id: 'cel-tm',
        layerId: 'tm',
        frameId: 'f1',
        x: 0,
        y: 0,
        width: W,
        height: H,
      };
      allocateGrid(cel.id, 2, 2);
      const sprite: Sprite = {
        width: W,
        height: H,
        colorMode: 'rgba',
        layers: [tilemapLayer],
        frames: [frame],
        cels: [cel],
        tags: [],
        tilesets: [],
      };
      const out = flattenSprite(sprite, 'f1');
      expect(Array.from(out)).toEqual(new Array(W * H * 4).fill(0));
    });
  });
});
