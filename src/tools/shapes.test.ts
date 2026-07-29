import { describe, expect, it } from 'vitest';
import { getPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import { drawEllipse, drawRect, ellipsePoints, ellipseSelection, normalizeDrag } from './shapes';
import { ellipse, line, rectangle } from './line';
import { harness, litPixels } from './testHarness';

const RED: RGBA = [255, 0, 0, 255];

function render(w: number, h: number, draw: (buf: Uint8ClampedArray) => void): string[] {
  const buf = new Uint8ClampedArray(w * h * 4);
  draw(buf);
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += getPixel(buf, w, h, x, y)![3] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

describe('normalizeDrag', () => {
  it('orders the corners whichever way the drag went', () => {
    expect(normalizeDrag(7, 9, 2, 3)).toEqual({ left: 2, top: 3, right: 7, bottom: 9 });
  });
});

describe('drawRect', () => {
  it('outlines the dragged box', () => {
    expect(render(6, 5, (b) => drawRect(b, 6, 5, 1, 1, 4, 3, RED, false))).toEqual([
      '......',
      '.####.',
      '.#..#.',
      '.####.',
      '......',
    ]);
  });

  it('fills when asked', () => {
    expect(render(6, 5, (b) => drawRect(b, 6, 5, 1, 1, 4, 3, RED, true))).toEqual([
      '......',
      '.####.',
      '.####.',
      '.####.',
      '......',
    ]);
  });

  it('is a single pixel for a zero-size drag', () => {
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    drawRect(buf, 4, 4, 2, 2, 2, 2, RED, false);
    expect(litPixels(buf, 4, 4)).toEqual(new Set(['2,2']));
  });

  it('clips to a selection (`docs/08-roadmap.md` Phase 3)', () => {
    const buf = new Uint8ClampedArray(6 * 5 * 4);
    drawRect(buf, 6, 5, 1, 1, 4, 3, RED, true, { bounds: { x: 2, y: 0, width: 2, height: 5 } });
    expect(litPixels(buf, 6, 5)).toEqual(new Set(['2,1', '3,1', '2,2', '3,2', '2,3', '3,3']));
  });
});

describe('ellipsePoints', () => {
  it('is symmetric about both axes on an odd box', () => {
    expect(render(7, 7, (b) => drawEllipse(b, 7, 7, 0, 0, 6, 6, RED, false))).toEqual([
      '..###..',
      '.#...#.',
      '#.....#',
      '#.....#',
      '#.....#',
      '.#...#.',
      '..###..',
    ]);
  });

  it('is symmetric on an even box, where a centre-and-radius form would skew', () => {
    expect(render(8, 8, (b) => drawEllipse(b, 8, 8, 0, 0, 7, 7, RED, false))).toEqual([
      '..####..',
      '.#....#.',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '.#....#.',
      '..####..',
    ]);
  });

  it('is a genuine ellipse, not a scaled circle', () => {
    // A scaled circle would duplicate or skip pixels along the flat arcs; the
    // midpoint form gives a single-pixel-wide outline everywhere.
    expect(render(10, 5, (b) => drawEllipse(b, 10, 5, 0, 0, 9, 4, RED, false))).toEqual([
      '..######..',
      '.#......#.',
      '#........#',
      '.#......#.',
      '..######..',
    ]);
  });

  it('stays inside the dragged box', () => {
    for (const [w, h] of [
      [1, 1],
      [2, 1],
      [1, 5],
      [2, 6],
      [6, 2],
      [16, 10],
    ]) {
      for (const p of ellipsePoints(0, 0, w - 1, h - 1)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(w);
        expect(p.y).toBeLessThan(h);
      }
    }
  });

  it('degenerates to a line when a diameter is zero', () => {
    expect(ellipsePoints(2, 0, 2, 3)).toHaveLength(4);
    expect(ellipsePoints(0, 2, 3, 2)).toHaveLength(4);
  });

  it('fills without leaving holes', () => {
    expect(render(9, 9, (b) => drawEllipse(b, 9, 9, 0, 0, 8, 8, RED, true))).toEqual([
      '...###...',
      '.#######.',
      '.#######.',
      '#########',
      '#########',
      '#########',
      '.#######.',
      '.#######.',
      '...###...',
    ]);
  });
});

describe('ellipseSelection', () => {
  it('masks the same pixels a filled ellipse draw would light', () => {
    const drawn = render(9, 9, (b) => drawEllipse(b, 9, 9, 0, 0, 8, 8, RED, true));
    const sel = ellipseSelection(0, 0, 8, 8)!;
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const lx = x - sel.bounds.x;
        const ly = y - sel.bounds.y;
        const inMask =
          lx >= 0 &&
          ly >= 0 &&
          lx < sel.bounds.width &&
          ly < sel.bounds.height &&
          sel.mask![ly * sel.bounds.width + lx] === 1;
        expect(inMask).toBe(drawn[y][x] === '#');
      }
    }
  });
});

describe('shape tools preview from the pointer-down snapshot', () => {
  it('leaves only the final line, not every intermediate one', () => {
    const c = harness({ size: 8, anchor: { x: 0, y: 0 } });
    c.snapshot();
    line.onPointerDown(c, 0, 0);
    line.onPointerMove(c, 7, 0, 0, 0); // dragged right
    line.onPointerMove(c, 0, 7, 7, 0); // then down instead

    const lit = litPixels(c.buffer, 8, 8);
    expect(lit).toEqual(new Set(['0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '0,6', '0,7']));
  });

  it('preserves pixels that were already there', () => {
    const c = harness({ size: 8, anchor: { x: 2, y: 2 } });
    c.buffer.set([9, 9, 9, 255], (5 * 8 + 5) * 4);
    c.snapshot();
    rectangle.onPointerDown(c, 2, 2);
    rectangle.onPointerMove(c, 3, 3, 2, 2);
    expect(getPixel(c.buffer, 8, 8, 5, 5)).toEqual([9, 9, 9, 255]);
  });

  it('draws the ellipse inscribed in the drag', () => {
    const c = harness({ size: 8, anchor: { x: 0, y: 0 } });
    c.snapshot();
    ellipse.onPointerDown(c, 0, 0);
    ellipse.onPointerMove(c, 6, 6, 0, 0);
    expect(litPixels(c.buffer, 8, 8).has('3,0')).toBe(true);
    expect(litPixels(c.buffer, 8, 8).has('0,0')).toBe(false);
  });
});
