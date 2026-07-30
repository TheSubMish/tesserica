import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateGrid,
  clearAllGrids,
  getGrid,
  getGridCell,
  gridRevision,
  releaseGrid,
  setGrid,
  setGridCell,
} from './tileGridBuffers';

beforeEach(() => {
  clearAllGrids();
});

describe('allocateGrid / getGrid', () => {
  it('allocates an all-empty (id 0) grid of the requested size', () => {
    const g = allocateGrid('c1', 3, 2);
    expect(g.length).toBe(6);
    expect([...g]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(getGrid('c1')).toBe(g);
  });

  it('bumps the revision on every allocation/set', () => {
    const before = gridRevision('c1');
    allocateGrid('c1', 1, 1);
    expect(gridRevision('c1')).toBe(before + 1);
    setGrid('c1', new Uint32Array(1));
    expect(gridRevision('c1')).toBe(before + 2);
  });
});

describe('getGridCell / setGridCell', () => {
  it('reads and writes a single cell by (col, row)', () => {
    const g = allocateGrid('c1', 3, 2);
    setGridCell(g, 3, 2, 1, 1, 42);
    expect(getGridCell(g, 3, 2, 1, 1)).toBe(42);
    // Row-major: (1,1) in a 3-wide grid is index 4.
    expect(g[4]).toBe(42);
  });

  it('is a silent no-op / returns undefined out of bounds', () => {
    const g = allocateGrid('c1', 2, 2);
    setGridCell(g, 2, 2, 5, 5, 99); // should not throw, should not write anywhere real
    expect([...g]).toEqual([0, 0, 0, 0]);
    expect(getGridCell(g, 2, 2, -1, 0)).toBeUndefined();
    expect(getGridCell(g, 2, 2, 0, 5)).toBeUndefined();
  });
});

describe('releaseGrid / clearAllGrids', () => {
  it('forgets a grid on release', () => {
    allocateGrid('c1', 1, 1);
    releaseGrid('c1');
    expect(getGrid('c1')).toBeUndefined();
  });

  it('clears everything', () => {
    allocateGrid('c1', 1, 1);
    allocateGrid('c2', 1, 1);
    clearAllGrids();
    expect(getGrid('c1')).toBeUndefined();
    expect(getGrid('c2')).toBeUndefined();
  });
});
