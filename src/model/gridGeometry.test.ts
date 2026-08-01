import { describe, expect, it } from 'vitest';
import { cellOrigin, defaultGridOffset, pixelToCell, tileDrawOrder } from './gridGeometry';
import type { GridSpec } from './types';

const rectGrid: GridSpec = { shape: 'rect', tileWidth: 16, tileHeight: 16, offsetX: 0, offsetY: 0 };
const isoGrid: GridSpec = {
  shape: 'isometric',
  tileWidth: 32,
  tileHeight: 16,
  offsetX: 0,
  offsetY: 0,
};
const hexGrid: GridSpec = {
  shape: 'hexagonal',
  tileWidth: 20,
  tileHeight: 24,
  offsetX: 0,
  offsetY: 0,
};

describe('cellOrigin — rect', () => {
  it('is a plain grid multiply, offset applied', () => {
    expect(cellOrigin(rectGrid, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(cellOrigin(rectGrid, 2, 3)).toEqual({ x: 32, y: 48 });
    const offsetGrid: GridSpec = { ...rectGrid, offsetX: 5, offsetY: 7 };
    expect(cellOrigin(offsetGrid, 2, 3)).toEqual({ x: 37, y: 55 });
  });
});

describe('cellOrigin — isometric (2:1 diamond)', () => {
  it('places (0,0) at the offset, growing right+down per column and left+down per row', () => {
    expect(cellOrigin(isoGrid, 0, 0)).toEqual({ x: 0, y: 0 });
    // +1 column: half a tile right, half a tile down.
    expect(cellOrigin(isoGrid, 1, 0)).toEqual({ x: 16, y: 8 });
    // +1 row: half a tile *left*, half a tile down.
    expect(cellOrigin(isoGrid, 0, 1)).toEqual({ x: -16, y: 8 });
    // col == row keeps x at the offset, y grows by a full tile height per step.
    expect(cellOrigin(isoGrid, 2, 2)).toEqual({ x: 0, y: 32 });
  });

  it('honours a non-zero offset', () => {
    const g: GridSpec = { ...isoGrid, offsetX: 100, offsetY: 50 };
    expect(cellOrigin(g, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(cellOrigin(g, 1, 0)).toEqual({ x: 116, y: 58 });
  });
});

describe('cellOrigin — hexagonal (pointy-top, odd-r)', () => {
  it('steps a full tile width per column, 3/4 tile height per row, even rows unshifted', () => {
    expect(cellOrigin(hexGrid, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(cellOrigin(hexGrid, 1, 0)).toEqual({ x: 20, y: 0 });
    expect(cellOrigin(hexGrid, 0, 2)).toEqual({ x: 0, y: 36 }); // 2 * 24 * 0.75 = 36
  });

  it('shifts odd rows right by half a tile width', () => {
    expect(cellOrigin(hexGrid, 0, 1)).toEqual({ x: 10, y: 18 }); // 24*0.75 = 18
    expect(cellOrigin(hexGrid, 1, 1)).toEqual({ x: 30, y: 18 });
  });
});

describe('pixelToCell — rect', () => {
  it('floors toward negative infinity, matching the original docPixelToCell', () => {
    expect(pixelToCell(rectGrid, 0, 0)).toEqual({ col: 0, row: 0 });
    expect(pixelToCell(rectGrid, 15, 15)).toEqual({ col: 0, row: 0 });
    expect(pixelToCell(rectGrid, 16, 16)).toEqual({ col: 1, row: 1 });
    expect(pixelToCell(rectGrid, -1, -1)).toEqual({ col: -1, row: -1 });
  });
});

describe('pixelToCell — isometric', () => {
  it('picks the diamond whose centre a point sits in, exactly at that centre', () => {
    // Centre of (0,0) is origin + (tw/2, th/2) = (16, 8).
    expect(pixelToCell(isoGrid, 16, 8)).toEqual({ col: 0, row: 0 });
  });

  it('round-trips every forward-transform centre back to its own (col, row)', () => {
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        const origin = cellOrigin(isoGrid, col, row);
        const cx = origin.x + isoGrid.tileWidth / 2;
        const cy = origin.y + isoGrid.tileHeight / 2;
        expect(pixelToCell(isoGrid, cx, cy)).toEqual({ col, row });
      }
    }
  });

  it('round-trips through a non-zero offset', () => {
    const g: GridSpec = { ...isoGrid, offsetX: 41, offsetY: -17 };
    for (const [col, row] of [
      [0, 0],
      [3, 1],
      [1, 4],
      [-2, 2],
    ]) {
      const origin = cellOrigin(g, col, row);
      const cx = origin.x + g.tileWidth / 2;
      const cy = origin.y + g.tileHeight / 2;
      expect(pixelToCell(g, cx, cy)).toEqual({ col, row });
    }
  });
});

describe('pixelToCell — hexagonal', () => {
  it('picks the hex cell whose bounding-box centre a point sits in, exactly at that centre', () => {
    const origin = cellOrigin(hexGrid, 0, 0);
    const cx = origin.x + hexGrid.tileWidth / 2;
    const cy = origin.y + hexGrid.tileHeight / 2;
    expect(pixelToCell(hexGrid, cx, cy)).toEqual({ col: 0, row: 0 });
  });

  it('round-trips every forward-transform centre back to its own (col, row), even/odd rows', () => {
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        const origin = cellOrigin(hexGrid, col, row);
        const cx = origin.x + hexGrid.tileWidth / 2;
        const cy = origin.y + hexGrid.tileHeight / 2;
        expect(pixelToCell(hexGrid, cx, cy)).toEqual({ col, row });
      }
    }
  });

  it('round-trips through a non-zero offset', () => {
    const g: GridSpec = { ...hexGrid, offsetX: 13, offsetY: 9 };
    for (const [col, row] of [
      [0, 0],
      [2, 1],
      [1, 3],
      [-1, 2],
    ]) {
      const origin = cellOrigin(g, col, row);
      const cx = origin.x + g.tileWidth / 2;
      const cy = origin.y + g.tileHeight / 2;
      expect(pixelToCell(g, cx, cy)).toEqual({ col, row });
    }
  });
});

describe('tileDrawOrder', () => {
  it('rect and hexagonal stay plain row-major (no overlap, order does not matter for correctness)', () => {
    expect(tileDrawOrder('rect', 2, 2)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
    ]);
    expect(tileDrawOrder('hexagonal', 2, 2)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
    ]);
  });

  it('isometric sorts back-to-front by ascending (col + row), a tie broken by col', () => {
    const order = tileDrawOrder('isometric', 3, 2);
    const sums = order.map((c) => c.col + c.row);
    expect(sums).toEqual([...sums].sort((a, b) => a - b));
    // (2,0) and (1,1) and (0,2)-if-it-existed all sum to 2; within a tie, col ascending.
    const sumTwo = order.filter((c) => c.col + c.row === 2);
    expect(sumTwo).toEqual([
      { col: 1, row: 1 },
      { col: 2, row: 0 },
    ]);
  });

  it('every cell in the extent appears exactly once regardless of shape', () => {
    for (const shape of ['rect', 'isometric', 'hexagonal'] as const) {
      const order = tileDrawOrder(shape, 4, 3);
      expect(order.length).toBe(12);
      const seen = new Set(order.map((c) => `${c.col},${c.row}`));
      expect(seen.size).toBe(12);
    }
  });
});

describe('defaultGridOffset', () => {
  it('centres an isometric grid horizontally on the canvas, offsetY at the top', () => {
    expect(defaultGridOffset('isometric', 32, 16, 256, 256)).toEqual({
      offsetX: 256 / 2 - 32 / 2,
      offsetY: 0,
    });
  });

  it('leaves rect and hexagonal at the canvas origin', () => {
    expect(defaultGridOffset('rect', 16, 16, 256, 256)).toEqual({ offsetX: 0, offsetY: 0 });
    expect(defaultGridOffset('hexagonal', 20, 24, 256, 256)).toEqual({ offsetX: 0, offsetY: 0 });
  });
});
