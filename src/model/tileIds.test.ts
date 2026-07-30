import { describe, expect, it } from 'vitest';
import {
  EMPTY_TILE_ID,
  FLIP_H_BIT,
  FLIP_V_BIT,
  TILE_INDEX_MASK,
  TRANSPOSE_BIT,
  packTileId,
  tileGridDims,
  unpackTileId,
} from './tileIds';

describe('packTileId / unpackTileId', () => {
  it('round-trips a plain index with no flags', () => {
    const id = packTileId(5);
    expect(id).toBe(5);
    expect(unpackTileId(id)).toEqual({ index: 5, flipH: false, flipV: false, transpose: false });
  });

  it('the empty tile is index 0, no flags', () => {
    expect(packTileId(0)).toBe(EMPTY_TILE_ID);
    expect(unpackTileId(EMPTY_TILE_ID)).toEqual({
      index: 0,
      flipH: false,
      flipV: false,
      transpose: false,
    });
  });

  it('sets exactly the requested flag bits', () => {
    expect(packTileId(0, { flipH: true })).toBe(FLIP_H_BIT);
    expect(packTileId(0, { flipV: true })).toBe(FLIP_V_BIT);
    expect(packTileId(0, { transpose: true })).toBe(TRANSPOSE_BIT);
  });

  it('round-trips every flag combination alongside a real index', () => {
    const combos: Array<{ flipH?: boolean; flipV?: boolean; transpose?: boolean }> = [
      {},
      { flipH: true },
      { flipV: true },
      { transpose: true },
      { flipH: true, flipV: true },
      { flipH: true, transpose: true },
      { flipV: true, transpose: true },
      { flipH: true, flipV: true, transpose: true },
    ];
    for (const flags of combos) {
      const id = packTileId(42, flags);
      const back = unpackTileId(id);
      expect(back.index).toBe(42);
      expect(back.flipH).toBe(!!flags.flipH);
      expect(back.flipV).toBe(!!flags.flipV);
      expect(back.transpose).toBe(!!flags.transpose);
    }
  });

  it('packs the maximum index with every flag set without overflowing into a negative int32', () => {
    const id = packTileId(TILE_INDEX_MASK, { flipH: true, flipV: true, transpose: true });
    expect(id).toBe(2 ** 31 - 1);
    expect(id).toBeGreaterThan(0);
    const back = unpackTileId(id);
    expect(back).toEqual({ index: TILE_INDEX_MASK, flipH: true, flipV: true, transpose: true });
  });

  it('rejects an out-of-range or non-integer index', () => {
    expect(() => packTileId(-1)).toThrow(RangeError);
    expect(() => packTileId(TILE_INDEX_MASK + 1)).toThrow(RangeError);
    expect(() => packTileId(1.5)).toThrow(RangeError);
  });

  it('flag bits do not leak into the unpacked index', () => {
    const id = packTileId(7, { flipH: true, flipV: true, transpose: true });
    expect(unpackTileId(id).index).toBe(7);
  });
});

describe('tileGridDims', () => {
  it('divides evenly when the cel is a whole multiple of the tile size', () => {
    expect(tileGridDims({ width: 64, height: 32 }, { tileWidth: 16, tileHeight: 16 })).toEqual({
      cols: 4,
      rows: 2,
    });
  });

  it('floors a partial trailing tile rather than rounding up', () => {
    expect(tileGridDims({ width: 20, height: 20 }, { tileWidth: 16, tileHeight: 16 })).toEqual({
      cols: 1,
      rows: 1,
    });
  });

  it('never returns a negative dimension', () => {
    expect(tileGridDims({ width: 4, height: 4 }, { tileWidth: 16, tileHeight: 16 })).toEqual({
      cols: 0,
      rows: 0,
    });
  });
});
