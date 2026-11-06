import { describe, expect, it } from 'vitest';

import { footprint } from './brush';
import { pencil } from './pencil';
import { stampBrush } from './raster';
import { harness } from './testHarness';

const shape = (s: Parameters<typeof footprint>[0], n: number) => {
  const rows = Array.from({ length: n }, () => Array<string>(n).fill('.'));
  for (const [x, y] of footprint(s, n)) rows[y][x] = '#';
  return rows.map((r) => r.join(''));
};

describe('footprint', () => {
  it('size 1 is one pixel for every shape', () => {
    for (const s of ['square', 'circle', 'slash', 'backslash'] as const) {
      expect(footprint(s, 1)).toEqual([[0, 0]]);
    }
  });

  it('a square fills its box', () => {
    expect(footprint('square', 4)).toHaveLength(16);
  });

  it('round brushes are the shapes pixel artists expect', () => {
    expect(shape('circle', 2)).toEqual(['##', '##']);
    expect(shape('circle', 3)).toEqual(['.#.', '###', '.#.']);
    expect(shape('circle', 4)).toEqual(['.##.', '####', '####', '.##.']);
    expect(shape('circle', 5)).toEqual(['.###.', '#####', '#####', '#####', '.###.']);
  });

  it('diagonal brushes run corner to corner', () => {
    expect(shape('slash', 3)).toEqual(['..#', '.#.', '#..']);
    expect(shape('backslash', 3)).toEqual(['#..', '.#.', '..#']);
  });

  it('every round brush is symmetric both ways', () => {
    for (let n = 2; n <= 12; n++) {
      const rows = shape('circle', n);
      expect(rows).toEqual(rows.map((r) => [...r].reverse().join('')));
      expect(rows).toEqual([...rows].reverse());
    }
  });
});

describe('stampBrush shape', () => {
  it('paints only the footprint', () => {
    const ctx = harness({ size: 7 });
    stampBrush(ctx.buffer, 7, 7, 3, 3, 3, [255, 0, 0, 255], null, {
      shape: 'circle',
      ink: 'normal',
    });
    const painted: string[] = [];
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) if (ctx.buffer[(y * 7 + x) * 4 + 3]) painted.push(`${x},${y}`);
    expect(painted.sort()).toEqual(['2,3', '3,2', '3,3', '3,4', '4,3']);
  });
});

describe('lock-alpha ink (RGBA)', () => {
  const at = (buf: Uint8ClampedArray, x: number, y: number) => [
    ...buf.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
  ];

  it('recolours painted pixels, keeps their alpha, and never paints transparency', () => {
    const ctx = harness({ size: 4, ink: 'lock-alpha', primary: [0, 255, 0, 255] });
    const buf = ctx.buffer as Uint8ClampedArray;
    buf.set([200, 0, 0, 128], (1 * 4 + 1) * 4); // half-transparent red at (1,1)
    ctx.snapshot();

    pencil.onPointerDown(ctx, 1, 1);
    pencil.onPointerDown(ctx, 2, 2); // transparent: must stay untouched

    expect(at(buf, 1, 1)).toEqual([0, 255, 0, 128]); // new colour, old alpha
    expect(at(buf, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it('normal ink still paints onto transparency', () => {
    const ctx = harness({ size: 4, primary: [0, 255, 0, 255] });
    pencil.onPointerDown(ctx, 2, 2);
    expect(at(ctx.buffer as Uint8ClampedArray, 2, 2)).toEqual([0, 255, 0, 255]);
  });

  it('applies to every pixel of a larger brush, pixel by pixel', () => {
    const ctx = harness({ size: 4, ink: 'lock-alpha', brushSize: 2, primary: [0, 0, 255, 255] });
    const buf = ctx.buffer as Uint8ClampedArray;
    buf.set([9, 9, 9, 255], (1 * 4 + 1) * 4);
    pencil.onPointerDown(ctx, 1, 1); // 2×2 stamp over (1,1)..(2,2): only (1,1) has coverage
    expect(at(buf, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(at(buf, 2, 1)[3]).toBe(0);
    expect(at(buf, 1, 2)[3]).toBe(0);
  });
});

describe('lock-alpha ink (indexed)', () => {
  it('leaves transparent indices alone and recolours the rest', () => {
    const buf = new Uint8Array(4); // 2×2, all transparent (index 0)
    buf[1] = 3; // (1,0) is painted with palette index 3
    stampBrush(buf, 2, 2, 0, 0, 1, [5], null, { shape: 'square', ink: 'lock-alpha' });
    stampBrush(buf, 2, 2, 1, 0, 1, [5], null, { shape: 'square', ink: 'lock-alpha' });
    expect([...buf]).toEqual([0, 5, 0, 0]);
  });
});
