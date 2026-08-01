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

describe('select tool — rect mode (default)', () => {
  it('is read-only — a marquee drag makes no undo step', () => {
    expect(select.readOnly).toBe(true);
  });

  it('grows the selection as the drag continues', () => {
    const c = harness({ anchor: { x: 1, y: 1 } });
    select.onPointerDown(c, 1, 1);
    expect(c.selection).toEqual({ bounds: { x: 1, y: 1, width: 1, height: 1 } });

    select.onPointerMove(c, 5, 4, 1, 1);
    expect(c.selection).toEqual({ bounds: { x: 1, y: 1, width: 5, height: 4 } });
  });

  it('deselects on a click with no drag', () => {
    const c = harness({
      anchor: { x: 2, y: 2 },
      selection: { bounds: { x: 0, y: 0, width: 8, height: 8 } },
    });
    select.onPointerUp?.(c, 2, 2);
    expect(c.selection).toBeNull();
  });

  it('keeps the selection when the pointer actually moved', () => {
    const c = harness({ anchor: { x: 2, y: 2 } });
    select.onPointerDown(c, 2, 2);
    select.onPointerMove(c, 6, 6, 2, 2);
    select.onPointerUp?.(c, 6, 6);
    expect(c.selection).toEqual({ bounds: { x: 2, y: 2, width: 5, height: 5 } });
  });
});

describe('select tool — ellipse mode', () => {
  it('produces a masked selection inscribed in the drag box', () => {
    const c = harness({ anchor: { x: 0, y: 0 }, selectMode: 'ellipse' });
    select.onPointerDown(c, 0, 0);
    select.onPointerMove(c, 4, 4, 0, 0);
    expect(c.selection).not.toBeNull();
    expect(c.selection?.mask).toBeInstanceOf(Uint8Array);
    // A 5×5 ellipse does not fill its corners — it is not a rectangle.
    const sel = c.selection!;
    const cornerLocal = 0 * sel.bounds.width + 0;
    expect(sel.mask![cornerLocal]).toBe(0);
  });

  it('deselects on a click with no drag', () => {
    const c = harness({ anchor: { x: 2, y: 2 }, selectMode: 'ellipse' });
    select.onPointerDown(c, 2, 2);
    select.onPointerUp?.(c, 2, 2);
    expect(c.selection).toBeNull();
  });
});

describe('select tool — lasso mode', () => {
  it('rasterizes a freehand triangle into a mask', () => {
    const c = harness({ anchor: { x: 0, y: 0 }, selectMode: 'lasso' });
    select.onPointerDown(c, 0, 0);
    select.onPointerMove(c, 6, 0, 0, 0);
    select.onPointerMove(c, 0, 6, 6, 0);
    select.onPointerUp?.(c, 0, 0);

    expect(c.selection).not.toBeNull();
    expect(c.selection?.mask).toBeInstanceOf(Uint8Array);
  });

  it('deselects a click too short to form a polygon', () => {
    const c = harness({ anchor: { x: 3, y: 3 }, selectMode: 'lasso' });
    select.onPointerDown(c, 3, 3);
    select.onPointerUp?.(c, 3, 3);
    expect(c.selection).toBeNull();
  });
});

describe('select tool — wand mode', () => {
  it('selects the contiguous region matching the seed colour', () => {
    // Everything is transparent black by default — the whole 8×8 buffer is
    // one contiguous region of the seed colour.
    const c = harness({ anchor: { x: 0, y: 0 }, selectMode: 'wand' });
    select.onPointerDown(c, 0, 0);
    expect(c.selection?.bounds).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    expect(Array.from(c.selection!.mask!)).toEqual(new Array(64).fill(1));
  });

  it('does not react to a drag', () => {
    const c = harness({ anchor: { x: 0, y: 0 }, selectMode: 'wand' });
    select.onPointerDown(c, 0, 0);
    const after = c.selection;
    select.onPointerMove(c, 4, 4, 0, 0);
    expect(c.selection).toEqual(after);
  });

  it('reads the correct one-byte-per-pixel layout on an indexed cel (docs/08-roadmap.md Phase 7)', () => {
    const buf = new Uint8Array(64); // every pixel index 0
    buf[5] = 3; // one differently-indexed pixel, must not be selected with the rest
    const c = harness({
      anchor: { x: 0, y: 0 },
      selectMode: 'wand',
      colorMode: 'indexed',
      buffer: buf,
    });
    select.onPointerDown(c, 0, 0);
    expect(c.selection?.mask![5]).toBe(0);
    expect(c.selection?.mask![6]).toBe(1);
  });
});
