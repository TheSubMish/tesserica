import { beforeEach, describe, expect, it } from 'vitest';
import { allocateBuffer, clearAllBuffers, setPixel } from './pixelBuffers';
import { allocateIndexBuffer, clearAllIndexBuffers } from './indexBuffers';
import { buildPatternChart, DEFAULT_MAX_DERIVED_COLORS } from './patternChart';
import type { Cel, Frame, Layer, LayerBase, Palette, Sprite } from './types';

const W = 3;
const H = 2;

function layer(over: Partial<LayerBase> = {}): Layer {
  return {
    id: 'l1',
    kind: 'raster',
    name: 'l1',
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

function makeRgbaSprite(): Sprite {
  const frame: Frame = { id: 'f1', durationMs: 100 };
  const cel: Cel = {
    id: 'cel-l1',
    layerId: 'l1',
    frameId: frame.id,
    x: 0,
    y: 0,
    width: W,
    height: H,
  };
  allocateBuffer(cel.id, W, H);
  return {
    width: W,
    height: H,
    colorMode: 'rgba',
    layers: [layer()],
    frames: [frame],
    cels: [cel],
    tags: [],
    tilesets: [],
  };
}

function makeIndexedSprite(palette: Palette): Sprite {
  const frame: Frame = { id: 'f1', durationMs: 100 };
  const cel: Cel = {
    id: 'cel-l1',
    layerId: 'l1',
    frameId: frame.id,
    x: 0,
    y: 0,
    width: W,
    height: H,
  };
  allocateIndexBuffer(cel.id, W, H);
  return {
    width: W,
    height: H,
    colorMode: 'indexed',
    layers: [layer()],
    frames: [frame],
    cels: [cel],
    tags: [],
    tilesets: [],
    palette,
  };
}

beforeEach(() => {
  clearAllBuffers();
  clearAllIndexBuffers();
});

describe('buildPatternChart — RGBA sprite (derived palette)', () => {
  it('counts pixels per color and marks fully-transparent pixels as empty cells', () => {
    const sprite = makeRgbaSprite();
    const buf = allocateBuffer('cel-l1', W, H);
    // Row 0: red, red, transparent. Row 1: blue, blue, blue.
    setPixel(buf, W, H, 0, 0, [255, 0, 0, 255]);
    setPixel(buf, W, H, 1, 0, [255, 0, 0, 255]);
    setPixel(buf, W, H, 2, 0, [0, 0, 0, 0]);
    setPixel(buf, W, H, 0, 1, [0, 0, 255, 255]);
    setPixel(buf, W, H, 1, 1, [0, 0, 255, 255]);
    setPixel(buf, W, H, 2, 1, [0, 0, 255, 255]);

    const chart = buildPatternChart(sprite, 'f1');

    expect(chart.derived).toBe(true);
    expect(chart.width).toBe(W);
    expect(chart.height).toBe(H);

    // Blue (3 pixels) outranks red (2 pixels) — legend is ordered by descending count.
    expect(chart.legend).toHaveLength(2);
    expect(chart.legend[0].color).toEqual([0, 0, 255, 255]);
    expect(chart.legend[0].count).toBe(3);
    expect(chart.legend[1].color).toEqual([255, 0, 0, 255]);
    expect(chart.legend[1].count).toBe(2);

    // Grid values reference legend position; -1 marks the transparent cell.
    const bluePos = chart.legend[0].position;
    const redPos = chart.legend[1].position;
    expect(Array.from(chart.grid)).toEqual([redPos, redPos, -1, bluePos, bluePos, bluePos]);

    // Every count sums to the number of non-empty cells.
    const total = chart.legend.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(5);
  });

  it('treats a pixel below the alpha threshold as empty, not as a very-transparent color', () => {
    const sprite = makeRgbaSprite();
    const buf = allocateBuffer('cel-l1', W, H);
    setPixel(buf, W, H, 0, 0, [10, 20, 30, 50]); // alpha well under the 128 threshold

    const chart = buildPatternChart(sprite, 'f1');
    expect(chart.grid[0]).toBe(-1);
    expect(chart.legend).toHaveLength(0);
  });

  it('caps derived colors at maxColors even for a sprite with many distinct colors', () => {
    const sprite: Sprite = { ...makeRgbaSprite(), width: 8, height: 8 };
    const cel: Cel = {
      id: 'cel-l1',
      layerId: 'l1',
      frameId: 'f1',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    };
    sprite.cels = [cel];
    const buf = allocateBuffer(cel.id, 8, 8);
    // 64 distinct, fully opaque colors — far more than the default cap.
    let n = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++, n++) {
        setPixel(buf, 8, 8, x, y, [n * 3, (n * 7) % 256, (n * 11) % 256, 255]);
      }
    }

    const chart = buildPatternChart(sprite, 'f1');
    expect(chart.legend.length).toBeLessThanOrEqual(DEFAULT_MAX_DERIVED_COLORS);
    // Every one of the 64 pixels still lands on some legend entry.
    expect(Array.from(chart.grid).every((v) => v >= 0)).toBe(true);
  });

  it('honors an explicit maxColors option', () => {
    const sprite: Sprite = { ...makeRgbaSprite(), width: 4, height: 4 };
    const cel: Cel = {
      id: 'cel-l1',
      layerId: 'l1',
      frameId: 'f1',
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    };
    sprite.cels = [cel];
    const buf = allocateBuffer(cel.id, 4, 4);
    let n = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++, n++) {
        setPixel(buf, 4, 4, x, y, [n * 16, (n * 32) % 256, (n * 48) % 256, 255]);
      }
    }

    const chart = buildPatternChart(sprite, 'f1', { maxColors: 3 });
    expect(chart.legend.length).toBeLessThanOrEqual(3);
  });
});

describe('buildPatternChart — indexed sprite (own palette)', () => {
  it('uses the sprite palette verbatim rather than deriving one', () => {
    const palette: Palette = {
      id: 'p1',
      name: 'Test',
      colors: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ],
    };
    const sprite = makeIndexedSprite(palette);
    const buf = allocateIndexBuffer('cel-l1', W, H);
    // Raw index 0 is reserved transparent; palette entry i is raw index i+1.
    buf[0] = 1; // red
    buf[1] = 1; // red
    buf[2] = 0; // transparent
    buf[3] = 3; // blue
    buf[4] = 3; // blue
    buf[5] = 3; // blue

    const chart = buildPatternChart(sprite, 'f1');

    expect(chart.derived).toBe(false);
    expect(chart.legend.map((e) => e.color)).toEqual(
      expect.arrayContaining([
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ]),
    );
    expect(chart.legend.every((e) => e.color !== undefined)).toBe(true);
    expect(chart.grid[2]).toBe(-1);

    const total = chart.legend.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(5);
  });

  it('falls back to a derived palette for an indexed sprite with no palette assigned', () => {
    const sprite = makeIndexedSprite({ id: 'empty', name: 'Empty', colors: [] });
    const buf = allocateIndexBuffer('cel-l1', W, H);
    buf.fill(0); // fully transparent — nothing to quantize either way

    const chart = buildPatternChart(sprite, 'f1');
    expect(chart.derived).toBe(true);
    expect(chart.legend).toHaveLength(0);
  });
});
