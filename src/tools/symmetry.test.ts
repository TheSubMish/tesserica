import { describe, expect, it } from 'vitest';

import { pencil } from './pencil';
import { rectangle } from './line';
import { select } from './select';
import type { Tool } from './Tool';
import { harness } from './testHarness';
import {
  mirrorCoord,
  mirrorPoint,
  mirrorsFor,
  MIRRORABLE_TOOLS,
  replayMirrored,
  runPhase,
} from './symmetry';

describe('mirrorsFor', () => {
  it('is just the identity with no axes', () => {
    expect(mirrorsFor(false, false)).toEqual([{ flipX: false, flipY: false }]);
  });

  it('adds one reflection per axis and the double reflection for both', () => {
    expect(mirrorsFor(true, false)).toHaveLength(2);
    expect(mirrorsFor(false, true)).toHaveLength(2);
    const both = mirrorsFor(true, true);
    expect(both).toHaveLength(4);
    expect(both[0]).toEqual({ flipX: false, flipY: false }); // identity stays first
    expect(both[3]).toEqual({ flipX: true, flipY: true });
  });
});

describe('mirrorCoord', () => {
  it('reflects across the centre of the span', () => {
    expect(mirrorCoord(0, 8)).toBe(7);
    expect(mirrorCoord(3, 8)).toBe(4); // the two middle pixels swap
    expect(mirrorCoord(4, 9)).toBe(4); // an odd span's centre maps to itself
  });

  it('is its own inverse', () => {
    for (const len of [7, 8, 64]) {
      for (let c = 0; c < len; c++) expect(mirrorCoord(mirrorCoord(c, len), len)).toBe(c);
    }
  });

  it('keeps an even brush footprint an exact reflection', () => {
    // A size-2 brush at x stamps [x, x+1]; its mirror in an 8-wide span must be
    // the reflection of that footprint, [6-x, 7-x].
    for (let x = 0; x < 6; x++) {
      const m = mirrorCoord(x, 8, 2);
      expect([m, m + 1].sort()).toEqual([7 - (x + 1), 7 - x].sort());
    }
  });

  it('leaves odd brushes uncorrected', () => {
    expect(mirrorCoord(2, 8, 3)).toBe(mirrorCoord(2, 8, 1));
  });
});

describe('mirrorPoint', () => {
  it('only applies the brush correction to brush tools', () => {
    const m = { flipX: true, flipY: false };
    expect(mirrorPoint(m, 2, 5, 8, 8, 'pencil', 2)).toEqual({ x: 4, y: 5 });
    expect(mirrorPoint(m, 2, 5, 8, 8, 'rect', 2)).toEqual({ x: 5, y: 5 });
  });

  it('mirrors y independently', () => {
    expect(mirrorPoint({ flipX: false, flipY: true }, 2, 1, 8, 8, 'line', 1)).toEqual({
      x: 2,
      y: 6,
    });
  });
});

describe('MIRRORABLE_TOOLS', () => {
  it('covers the drawing tools and nothing that selects or reads', () => {
    expect([...MIRRORABLE_TOOLS].sort()).toEqual(['ellipse', 'eraser', 'line', 'pencil', 'rect']);
  });
});

describe('replayMirrored, driving the real tools', () => {
  const alphaAt = (buf: Uint8ClampedArray, w: number, x: number, y: number) =>
    buf[(y * w + x) * 4 + 3];
  const painted = (buf: Uint8ClampedArray, w: number, h: number) => {
    const out: string[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (alphaAt(buf, w, x, y)) out.push(`${x},${y}`);
    return out.sort();
  };

  function stroke(
    tool: Tool,
    from: [number, number],
    to: [number, number],
    sx: boolean,
    sy: boolean,
    size = 1,
  ) {
    const ctx = harness({ size: 8, brushSize: size });
    const states: Record<string, unknown>[] = [];
    ctx.anchor = { x: from[0], y: from[1] };
    const go = (phase: 'down' | 'move', x: number, y: number, px: number, py: number) => {
      runPhase(tool, phase, ctx, x, y, px, py);
      replayMirrored({
        tool,
        phase,
        ctx,
        x,
        y,
        prevX: px,
        prevY: py,
        symmetryX: sx,
        symmetryY: sy,
        states,
      });
    };
    go('down', from[0], from[1], from[0], from[1]);
    go('move', to[0], to[1], from[0], from[1]);
    return ctx;
  }

  it('paints a mirrored pencil dab', () => {
    const ctx = stroke(pencil, [1, 2], [1, 2], true, false);
    expect(painted(ctx.buffer as Uint8ClampedArray, 8, 8)).toEqual(['1,2', '6,2']);
  });

  it('four-way symmetry paints four dabs', () => {
    const ctx = stroke(pencil, [1, 2], [1, 2], true, true);
    expect(painted(ctx.buffer as Uint8ClampedArray, 8, 8)).toEqual(['1,2', '1,5', '6,2', '6,5']);
  });

  it('an even brush mirrors as an exact reflection', () => {
    const ctx = stroke(pencil, [1, 1], [1, 1], true, false, 2);
    // size 2 at (1,1) covers x 1..2; mirror in an 8-wide sprite covers x 5..6.
    expect(painted(ctx.buffer as Uint8ClampedArray, 8, 8)).toEqual([
      '1,1',
      '1,2',
      '2,1',
      '2,2',
      '5,1',
      '5,2',
      '6,1',
      '6,2',
    ]);
  });

  it('a mirrored rectangle preview is not wiped by the other copy restoring', () => {
    const ctx = stroke(rectangle, [0, 0], [2, 2], true, false);
    const cells = painted(ctx.buffer as Uint8ClampedArray, 8, 8);
    expect(cells).toContain('0,0');
    expect(cells).toContain('7,0'); // the mirrored corner survived
    expect(cells).toContain('5,2');
  });

  it('does nothing for tools that read or select', () => {
    const ctx = stroke(select, [1, 1], [3, 3], true, true);
    expect(painted(ctx.buffer as Uint8ClampedArray, 8, 8)).toEqual([]);
  });
});
