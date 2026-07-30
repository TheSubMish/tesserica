import { beforeEach, describe, expect, it } from 'vitest';
import { allocateGrid, setGridCell } from './tileGridBuffers';
import { clearAllTileBuffers, setTileBuffer } from './tileBuffers';
import { packTileId } from './tileIds';
import {
  flipTileH,
  flipTileV,
  renderTilemapCel,
  resolveTilePixels,
  transposeTile,
} from './tilemapRender';
import type { GridSpec, Tileset } from './types';

const grid: GridSpec = { shape: 'rect', tileWidth: 2, tileHeight: 2, offsetX: 0, offsetY: 0 };

/** A 2×2 tile with four distinct, recognisable corners: TL red, TR green, BL blue, BR white. */
function cornerTile(): Uint8ClampedArray {
  return new Uint8ClampedArray([
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
  ]);
}

beforeEach(() => {
  clearAllTileBuffers();
});

describe('flipTileH / flipTileV / transposeTile', () => {
  it('flipH mirrors columns, keeping rows in place', () => {
    const flipped = flipTileH(cornerTile(), 2, 2);
    // TL<->TR, BL<->BR
    expect([...flipped.slice(0, 4)]).toEqual([0, 255, 0, 255]); // was TR (green)
    expect([...flipped.slice(4, 8)]).toEqual([255, 0, 0, 255]); // was TL (red)
    expect([...flipped.slice(8, 12)]).toEqual([255, 255, 255, 255]); // was BR (white)
    expect([...flipped.slice(12, 16)]).toEqual([0, 0, 255, 255]); // was BL (blue)
  });

  it('flipV mirrors rows, keeping columns in place', () => {
    const flipped = flipTileV(cornerTile(), 2, 2);
    expect([...flipped.slice(0, 4)]).toEqual([0, 0, 255, 255]); // was BL (blue)
    expect([...flipped.slice(4, 8)]).toEqual([255, 255, 255, 255]); // was BR (white)
    expect([...flipped.slice(8, 12)]).toEqual([255, 0, 0, 255]); // was TL (red)
    expect([...flipped.slice(12, 16)]).toEqual([0, 255, 0, 255]); // was TR (green)
  });

  it('transpose reflects across the main diagonal on a square tile', () => {
    const t = transposeTile(cornerTile(), 2, 2);
    // TL stays, TR<->BL, BR stays.
    expect([...t.slice(0, 4)]).toEqual([255, 0, 0, 255]); // TL unchanged
    expect([...t.slice(4, 8)]).toEqual([0, 0, 255, 255]); // now BL's old colour
    expect([...t.slice(8, 12)]).toEqual([0, 255, 0, 255]); // now TR's old colour
    expect([...t.slice(12, 16)]).toEqual([255, 255, 255, 255]); // BR unchanged
  });

  it('transpose is a documented no-op on a non-square tile', () => {
    const rect = new Uint8ClampedArray(2 * 1 * 4).fill(9);
    expect(transposeTile(rect, 2, 1)).toBe(rect);
  });
});

describe('resolveTilePixels', () => {
  it('returns null for an out-of-range tile index', () => {
    const tileset: Tileset = { id: 'ts1', name: 't', tileWidth: 2, tileHeight: 2, tiles: [] };
    expect(resolveTilePixels(tileset, packTileId(3))).toBeNull();
  });

  it('applies flip flags on top of the resolved buffer', () => {
    setTileBuffer('tile-a', cornerTile());
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'tile-a' }],
    };
    const flipped = resolveTilePixels(tileset, packTileId(1, { flipH: true }))!;
    expect([...flipped.slice(0, 4)]).toEqual([0, 255, 0, 255]);
  });
});

describe('renderTilemapCel', () => {
  it('blits each grid cell into place, nearest-neighbour (pixel-exact, no scaling)', () => {
    setTileBuffer(
      'solid-red',
      new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
    );
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'solid-red' }],
    };
    const cel = { width: 4, height: 2 };
    const gridBuf = allocateGrid('c1', 2, 1);
    setGridCell(gridBuf, 2, 1, 1, 0, packTileId(1)); // right cell only

    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    // Left 2×2 cell (index 0, empty) stays transparent.
    expect(out.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 0]));
    // Right 2×2 cell is opaque red.
    const rightPixel = (0 * cel.width + 2) * 4;
    expect([...out.slice(rightPixel, rightPixel + 4)]).toEqual([255, 0, 0, 255]);
  });

  it('renders a flipped tile pixel-exact within its cell', () => {
    setTileBuffer('corner', cornerTile());
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'corner' }],
    };
    const cel = { width: 2, height: 2 };
    const gridBuf = allocateGrid('c2', 1, 1);
    setGridCell(gridBuf, 1, 1, 0, 0, packTileId(1, { flipH: true }));

    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    // Unflipped TL was red; flipped TL should be green (old TR).
    expect([...out.slice(0, 4)]).toEqual([0, 255, 0, 255]);
    // Flipped TR should be red (old TL).
    expect([...out.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it('renders fully transparent when the tileset or grid is missing', () => {
    const cel = { width: 2, height: 2 };
    expect(renderTilemapCel(undefined, grid, allocateGrid('c3', 1, 1), cel)).toEqual(
      new Uint8ClampedArray(16),
    );
    const tileset: Tileset = { id: 'ts1', name: 't', tileWidth: 2, tileHeight: 2, tiles: [] };
    expect(renderTilemapCel(tileset, grid, undefined, cel)).toEqual(new Uint8ClampedArray(16));
  });

  it('clips a partial trailing tile at the cel edge rather than overwriting adjacent memory', () => {
    setTileBuffer('solid', new Uint8ClampedArray(16).fill(200));
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'solid' }],
    };
    // A 3-wide cel with 2px tiles: tileGridDims floors to 1 column, so the
    // trailing column is simply never drawn — no out-of-bounds write.
    const cel = { width: 3, height: 2 };
    const gridBuf = allocateGrid('c4', 1, 1);
    setGridCell(gridBuf, 1, 1, 0, 0, packTileId(1));
    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    expect(out.length).toBe(3 * 2 * 4);
  });
});
