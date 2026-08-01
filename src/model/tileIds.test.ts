import { describe, expect, it } from 'vitest';
import {
  EMPTY_TILE_ID,
  FLIP_H_BIT,
  FLIP_V_BIT,
  TILE_INDEX_MASK,
  TRANSPOSE_BIT,
  docPixelToCell,
  packTileId,
  tileGridDims,
  unpackTileId,
} from './tileIds';
import { cellOrigin } from './gridGeometry';
import type { GridSpec } from './types';

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
  const rectGrid = (tileWidth: number, tileHeight: number): GridSpec => ({
    shape: 'rect',
    tileWidth,
    tileHeight,
    offsetX: 0,
    offsetY: 0,
  });

  it('divides evenly when the cel is a whole multiple of the tile size', () => {
    expect(tileGridDims({ width: 64, height: 32 }, rectGrid(16, 16))).toEqual({
      cols: 4,
      rows: 2,
    });
  });

  it('floors a partial trailing tile rather than rounding up', () => {
    expect(tileGridDims({ width: 20, height: 20 }, rectGrid(16, 16))).toEqual({
      cols: 1,
      rows: 1,
    });
  });

  it('never returns a negative dimension', () => {
    expect(tileGridDims({ width: 4, height: 4 }, rectGrid(16, 16))).toEqual({
      cols: 0,
      rows: 0,
    });
  });

  describe('shape-aware extent (gap-closure — cols/rows via the forward transform, not a rect-only guess)', () => {
    /**
     * Generic forward/inverse-style proof, reused per shape/axis below: the
     * last addressable column/row's own `cellOrigin` box must lie fully
     * inside the cel, and the very next one must not — the same bar
     * `gridGeometry.test.ts` holds the coordinate transforms themselves to.
     */
    function assertTightFit(
      cel: { width: number; height: number },
      grid: GridSpec,
      cols: number,
      rows: number,
    ): void {
      // Last valid column (row held at 0) fits entirely inside the cel.
      if (cols > 0) {
        const last = cellOrigin(grid, cols - 1, 0);
        expect(last.x).toBeGreaterThanOrEqual(0);
        expect(last.x + grid.tileWidth).toBeLessThanOrEqual(cel.width);
      }
      // One more column genuinely would not fit.
      const oneMore = cellOrigin(grid, cols, 0);
      const oneMoreFits =
        oneMore.x >= 0 &&
        oneMore.y >= 0 &&
        oneMore.x + grid.tileWidth <= cel.width &&
        oneMore.y + grid.tileHeight <= cel.height;
      expect(oneMoreFits).toBe(false);

      // Last valid row (col held at 0) fits entirely inside the cel.
      if (rows > 0) {
        const last = cellOrigin(grid, 0, rows - 1);
        expect(last.y).toBeGreaterThanOrEqual(0);
        expect(last.y + grid.tileHeight).toBeLessThanOrEqual(cel.height);
      }
      // One more row genuinely would not fit.
      const oneMoreRow = cellOrigin(grid, 0, rows);
      const oneMoreRowFits =
        oneMoreRow.x >= 0 &&
        oneMoreRow.y >= 0 &&
        oneMoreRow.x + grid.tileWidth <= cel.width &&
        oneMoreRow.y + grid.tileHeight <= cel.height;
      expect(oneMoreRowFits).toBe(false);
    }

    it('isometric: packs more rows into a cel than the rect formula would (half-tile row step)', () => {
      const grid: GridSpec = {
        shape: 'isometric',
        tileWidth: 4,
        tileHeight: 2,
        offsetX: 0,
        offsetY: 0,
      };
      const cel = { width: 8, height: 4 };
      const { cols, rows } = tileGridDims(cel, grid);
      // The rect-only formula would report cols=2, rows=2 here — isometric's
      // half-tile-per-axis step packs more of both into the same cel.
      expect(cols).toBeGreaterThan(2);
      assertTightFit(cel, grid, cols, rows);
    });

    it('isometric: a taller cel unlocks more rows at a fixed width (centred offsetX, matching defaultGridOffset)', () => {
      // offsetX > 0 (as `defaultGridOffset` picks for a real isometric
      // layer) lets `col=0`'s box stay on-canvas as `row` grows — with
      // offsetX=0, row 1 alone already pushes x negative regardless of
      // height, which would make this a test of the x-bound, not the
      // height-driven row count this case is actually about.
      const grid: GridSpec = {
        shape: 'isometric',
        tileWidth: 4,
        tileHeight: 2,
        offsetX: 4,
        offsetY: 0,
      };
      const short = tileGridDims({ width: 16, height: 2 }, grid);
      const tall = tileGridDims({ width: 16, height: 4 }, grid);
      expect(tall.rows).toBeGreaterThan(short.rows);
      assertTightFit({ width: 16, height: 2 }, grid, short.cols, short.rows);
      assertTightFit({ width: 16, height: 4 }, grid, tall.cols, tall.rows);
    });

    it('hexagonal: row 1 is addressable in a cel exactly as tall as its true footprint needs, not a full extra tileHeight', () => {
      const grid: GridSpec = {
        shape: 'hexagonal',
        tileWidth: 4,
        tileHeight: 4,
        offsetX: 0,
        offsetY: 0,
      };
      // Row 1's box is y:[3,7) (row step = 0.75 * tileHeight = 3). The old
      // rect-only formula (`floor(height / tileHeight)`) needed height 8 to
      // report 2 rows; height 7 is enough once packing is shape-aware.
      const cel = { width: 8, height: 7 };
      const { cols, rows } = tileGridDims(cel, grid);
      expect(rows).toBe(2);
      assertTightFit(cel, grid, cols, rows);

      // One pixel shorter and row 1's box (needs y up to 7) no longer fits.
      const short = tileGridDims({ width: 8, height: 6 }, grid);
      expect(short.rows).toBe(1);
    });

    it('hexagonal: cols/rows still match rect exactly when the cel is a whole multiple (regression anchor)', () => {
      const grid: GridSpec = {
        shape: 'hexagonal',
        tileWidth: 4,
        tileHeight: 4,
        offsetX: 0,
        offsetY: 0,
      };
      const cel = { width: 8, height: 8 };
      expect(tileGridDims(cel, grid)).toEqual({ cols: 2, rows: 2 });
    });

    it('rect is unaffected: shape-aware extent reduces to the original plain division', () => {
      const grid = rectGrid(16, 16);
      expect(tileGridDims({ width: 64, height: 32 }, grid)).toEqual({ cols: 4, rows: 2 });
      assertTightFit({ width: 64, height: 32 }, grid, 4, 2);
    });
  });
});

describe('docPixelToCell', () => {
  const grid: GridSpec = { shape: 'rect', tileWidth: 8, tileHeight: 16, offsetX: 0, offsetY: 0 };

  it('maps a document pixel to its containing cell, cel offset at origin', () => {
    expect(docPixelToCell(0, 0, { x: 0, y: 0 }, grid)).toEqual({ col: 0, row: 0 });
    expect(docPixelToCell(7, 15, { x: 0, y: 0 }, grid)).toEqual({ col: 0, row: 0 });
    expect(docPixelToCell(8, 16, { x: 0, y: 0 }, grid)).toEqual({ col: 1, row: 1 });
    expect(docPixelToCell(23, 31, { x: 0, y: 0 }, grid)).toEqual({ col: 2, row: 1 });
  });

  it('accounts for a non-zero cel offset', () => {
    expect(docPixelToCell(10, 20, { x: 10, y: 16 }, grid)).toEqual({ col: 0, row: 0 });
    expect(docPixelToCell(18, 32, { x: 10, y: 16 }, grid)).toEqual({ col: 1, row: 1 });
  });

  it('floors toward negative infinity above/left of the grid, matching screenToDoc', () => {
    expect(docPixelToCell(-1, -1, { x: 0, y: 0 }, grid)).toEqual({ col: -1, row: -1 });
  });

  it('delegates to the shape-aware inverse transform for isometric/hexagonal grids', () => {
    const iso: GridSpec = {
      shape: 'isometric',
      tileWidth: 32,
      tileHeight: 16,
      offsetX: 0,
      offsetY: 0,
    };
    // Centre of the (2,1) diamond: origin (24,24) + (16,8).
    expect(docPixelToCell(40, 32, { x: 0, y: 0 }, iso)).toEqual({ col: 2, row: 1 });
    // A non-zero cel offset shifts the query point the same way rect does.
    expect(docPixelToCell(50, 42, { x: 10, y: 10 }, iso)).toEqual({ col: 2, row: 1 });

    const hex: GridSpec = {
      shape: 'hexagonal',
      tileWidth: 20,
      tileHeight: 24,
      offsetX: 0,
      offsetY: 0,
    };
    // Centre of (1,1): origin (30,18) + (10,12).
    expect(docPixelToCell(40, 30, { x: 0, y: 0 }, hex)).toEqual({ col: 1, row: 1 });
  });
});
