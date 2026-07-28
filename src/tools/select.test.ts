import { describe, expect, it } from 'vitest';
import { dragToRect, select } from './select';
import { harness } from './testHarness';

describe('dragToRect', () => {
  it('normalizes a drag in any direction to an inclusive rect', () => {
    expect(dragToRect(5, 5, 2, 3)).toEqual({ x: 2, y: 3, width: 4, height: 3 });
  });

  it('is a 1×1 rect for a single point', () => {
    expect(dragToRect(4, 4, 4, 4)).toEqual({ x: 4, y: 4, width: 1, height: 1 });
  });
});

describe('select tool', () => {
  it('is read-only — a marquee drag makes no undo step', () => {
    expect(select.readOnly).toBe(true);
  });

  it('grows the selection as the drag continues', () => {
    const c = harness({ anchor: { x: 1, y: 1 } });
    select.onPointerDown(c, 1, 1);
    expect(c.selection).toEqual({ x: 1, y: 1, width: 1, height: 1 });

    select.onPointerMove(c, 5, 4, 1, 1);
    expect(c.selection).toEqual({ x: 1, y: 1, width: 5, height: 4 });
  });

  it('deselects on a click with no drag', () => {
    const c = harness({ anchor: { x: 2, y: 2 }, selection: { x: 0, y: 0, width: 8, height: 8 } });
    select.onPointerUp?.(c, 2, 2);
    expect(c.selection).toBeNull();
  });

  it('keeps the selection when the pointer actually moved', () => {
    const c = harness({ anchor: { x: 2, y: 2 } });
    select.onPointerDown(c, 2, 2);
    select.onPointerMove(c, 6, 6, 2, 2);
    select.onPointerUp?.(c, 6, 6);
    expect(c.selection).toEqual({ x: 2, y: 2, width: 5, height: 5 });
  });
});
