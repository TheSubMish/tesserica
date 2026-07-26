import { describe, expect, it } from 'vitest';
import {
  EMPTY_RECT,
  growRect,
  intersectRect,
  isEmptyRect,
  rectArea,
  rectContains,
  rectsEqual,
  unionRect,
} from './rect';

describe('unionRect', () => {
  it('ignores empty operands rather than swallowing the origin', () => {
    // The naive min/max union would drag a rect back to (0,0) whenever one
    // side is the zero rect — which is exactly the case on the first pixel of
    // a stroke.
    const r = { x: 10, y: 12, width: 2, height: 3 };
    expect(unionRect(EMPTY_RECT, r)).toEqual(r);
    expect(unionRect(r, EMPTY_RECT)).toEqual(r);
    expect(unionRect(EMPTY_RECT, EMPTY_RECT)).toEqual(EMPTY_RECT);
  });

  it('covers both rects', () => {
    const u = unionRect({ x: 1, y: 1, width: 2, height: 2 }, { x: 5, y: 0, width: 1, height: 1 });
    expect(u).toEqual({ x: 1, y: 0, width: 5, height: 3 });
  });
});

describe('growRect', () => {
  it('turns an empty rect into a 1×1 rect at the point', () => {
    expect(growRect(EMPTY_RECT, 7, 9)).toEqual({ x: 7, y: 9, width: 1, height: 1 });
  });

  it('extends to include the point', () => {
    const r = growRect({ x: 4, y: 4, width: 1, height: 1 }, 6, 2);
    expect(r).toEqual({ x: 4, y: 2, width: 3, height: 3 });
  });
});

describe('intersectRect', () => {
  it('returns the overlap', () => {
    const i = intersectRect(
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 2, y: 3, width: 4, height: 4 },
    );
    expect(i).toEqual({ x: 2, y: 3, width: 2, height: 1 });
  });

  it('returns the empty rect when disjoint, not a negative one', () => {
    const i = intersectRect(
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 8, y: 8, width: 2, height: 2 },
    );
    expect(isEmptyRect(i)).toBe(true);
  });
});

describe('misc', () => {
  it('rectArea is zero for empty', () => {
    expect(rectArea(EMPTY_RECT)).toBe(0);
    expect(rectArea({ x: 0, y: 0, width: 3, height: 4 })).toBe(12);
  });

  it('rectContains excludes the far edge', () => {
    const r = { x: 1, y: 1, width: 2, height: 2 };
    expect(rectContains(r, 1, 1)).toBe(true);
    expect(rectContains(r, 2, 2)).toBe(true);
    expect(rectContains(r, 3, 2)).toBe(false);
  });

  it('rectsEqual compares by value', () => {
    expect(
      rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
    ).toBe(true);
  });
});
