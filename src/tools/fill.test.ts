import { describe, expect, it } from 'vitest';
import { getPixel, setPixel } from '../model/pixelBuffers';
import type { Palette, RGBA } from '../model/types';
import { fillContiguous, fillGlobal, wandSelection } from './fill';
import { bucket } from './bucket';
import { harness } from './testHarness';

const W = 8;
const H = 8;
const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];

const blank = () => new Uint8ClampedArray(W * H * 4);

/** A vertical wall at x=4, splitting the cel into two regions. */
function walled(): Uint8ClampedArray {
  const buf = blank();
  for (let y = 0; y < H; y++) setPixel(buf, W, H, 4, y, RED);
  return buf;
}

describe('fillContiguous', () => {
  it('fills the transparent region and stops at the wall', () => {
    const buf = walled();
    fillContiguous(buf, W, H, 0, 0, GREEN);

    expect(getPixel(buf, W, H, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 3, 7)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 4, 0)).toEqual([255, 0, 0, 255]); // the wall
    expect(getPixel(buf, W, H, 5, 0)).toEqual([0, 0, 0, 0]); // beyond it
  });

  it('does not leak diagonally', () => {
    // Two transparent regions touching only at a corner must stay separate:
    // 4-connectivity, not 8.
    const buf = blank();
    for (let i = 0; i < W; i++) setPixel(buf, W, H, i, i, RED);
    fillContiguous(buf, W, H, W - 1, 0, GREEN);
    expect(getPixel(buf, W, H, 0, H - 1)).toEqual([0, 0, 0, 0]);
  });

  it('terminates when the seed already has the fill colour', () => {
    const buf = blank();
    setPixel(buf, W, H, 2, 2, GREEN);
    fillContiguous(buf, W, H, 2, 2, GREEN);
    expect(getPixel(buf, W, H, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('ignores a seed outside the cel', () => {
    const buf = blank();
    fillContiguous(buf, W, H, -1, 3, GREEN);
    expect(buf.every((v) => v === 0)).toBe(true);
  });

  it('matches colour exactly, including alpha', () => {
    // A transparent pixel that happens to carry stale RGB is not the same
    // colour as a cleared one — straight alpha means RGB is still data.
    const buf = blank();
    setPixel(buf, W, H, 1, 1, [255, 0, 0, 0]);
    fillContiguous(buf, W, H, 0, 0, GREEN);
    expect(getPixel(buf, W, H, 1, 1)).toEqual([255, 0, 0, 0]);
  });
});

describe('fillGlobal', () => {
  it('recolours every matching pixel regardless of connectivity', () => {
    const buf = walled();
    fillGlobal(buf, W, H, 0, 0, GREEN);
    expect(getPixel(buf, W, H, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 7, 7)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 4, 3)).toEqual([255, 0, 0, 255]);
  });

  it('only recolours matching pixels inside a selection (`docs/08-roadmap.md` Phase 3)', () => {
    const buf = blank();
    fillGlobal(buf, W, H, 0, 0, GREEN, { bounds: { x: 0, y: 0, width: 4, height: 8 } });
    expect(getPixel(buf, W, H, 3, 0)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 4, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('fillContiguous — selection clipping', () => {
  it('cannot flood out through the selection boundary', () => {
    const buf = blank();
    fillContiguous(buf, W, H, 0, 0, GREEN, { bounds: { x: 0, y: 0, width: 4, height: 8 } });
    expect(getPixel(buf, W, H, 3, 7)).toEqual([0, 255, 0, 255]);
    expect(getPixel(buf, W, H, 4, 7)).toEqual([0, 0, 0, 0]);
  });

  it('ignores a seed outside the selection', () => {
    const buf = blank();
    fillContiguous(buf, W, H, 5, 0, GREEN, { bounds: { x: 0, y: 0, width: 4, height: 8 } });
    expect(buf.every((v) => v === 0)).toBe(true);
  });
});

describe('wandSelection', () => {
  it('selects the contiguous matching region, same footprint fillContiguous would paint', () => {
    const buf = walled();
    const sel = wandSelection(buf, W, H, 0, 0)!;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < 4; x++) {
        const lx = x - sel.bounds.x;
        const ly = y - sel.bounds.y;
        expect(sel.mask![ly * sel.bounds.width + lx]).toBe(1);
      }
    }
    // The wall itself is a different colour and must not be selected.
    expect(sel.bounds.width).toBe(4);
  });

  it('does not leak diagonally, matching fillContiguous', () => {
    const buf = blank();
    for (let i = 0; i < W; i++) setPixel(buf, W, H, i, i, RED);
    const sel = wandSelection(buf, W, H, W - 1, 0)!;
    const gx = 0;
    const gy = H - 1;
    const lx = gx - sel.bounds.x;
    const ly = gy - sel.bounds.y;
    const inSel =
      lx >= 0 &&
      ly >= 0 &&
      lx < sel.bounds.width &&
      ly < sel.bounds.height &&
      sel.mask![ly * sel.bounds.width + lx] === 1;
    expect(inSel).toBe(false);
  });

  it('returns null for a seed outside the buffer', () => {
    const buf = blank();
    expect(wandSelection(buf, W, H, -1, 0)).toBeNull();
  });
});

describe('bucket tool', () => {
  it('routes to the contiguous or global fill by the option', () => {
    const contiguous = harness({ buffer: walled(), fillContiguous: true, primary: GREEN });
    bucket.onPointerDown(contiguous, 0, 0);
    expect(getPixel(contiguous.buffer, W, H, 7, 7)).toEqual([0, 0, 0, 0]);

    const global = harness({ buffer: walled(), fillContiguous: false, primary: GREEN });
    bucket.onPointerDown(global, 0, 0);
    expect(getPixel(global.buffer, W, H, 7, 7)).toEqual([0, 255, 0, 255]);
  });

  it('does nothing on drag, so a fill cannot run away with the pointer', () => {
    const c = harness({ buffer: walled(), primary: GREEN });
    bucket.onPointerMove(c, 6, 6, 0, 0);
    expect(getPixel(c.buffer, W, H, 6, 6)).toEqual([0, 0, 0, 0]);
  });
});

describe('fill — indexed color mode (docs/08-roadmap.md Phase 7)', () => {
  const palette: Palette = {
    id: 'p1',
    name: 'P',
    colors: [
      [255, 0, 0, 255], // -> index 1
      [0, 255, 0, 255], // -> index 2
    ],
  };

  /** A vertical wall of index 1 at x=4, splitting the cel into two regions. */
  function walledIndexed(): Uint8Array {
    const buf = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) setPixel(buf, W, H, 4, y, [1]);
    return buf;
  }

  it('fillContiguous writes the resolved index, not RGBA', () => {
    const buf = walledIndexed();
    fillContiguous(buf, W, H, 0, 0, [2]); // green
    expect(getPixel(buf, W, H, 0, 0, 1)).toEqual([2]);
    expect(getPixel(buf, W, H, 4, 0, 1)).toEqual([1]); // the wall, untouched
    expect(getPixel(buf, W, H, 5, 0, 1)).toEqual([0]); // beyond it, untouched
  });

  it('fillGlobal writes the resolved index everywhere it matches', () => {
    const buf = walledIndexed();
    fillGlobal(buf, W, H, 0, 0, [2]);
    expect(getPixel(buf, W, H, 7, 7, 1)).toEqual([2]);
    expect(getPixel(buf, W, H, 4, 3, 1)).toEqual([1]);
  });

  it('wandSelection reads one byte per pixel when told bytesPerPixel=1', () => {
    const buf = walledIndexed();
    const sel = wandSelection(buf, W, H, 0, 0, 1)!;
    expect(sel.bounds.width).toBe(4);
  });

  it('bucket tool resolves the primary colour through the palette before filling', () => {
    const c = harness({
      colorMode: 'indexed',
      palette,
      buffer: walledIndexed(),
      fillContiguous: true,
      primary: [0, 255, 0, 255], // -> index 2
    });
    bucket.onPointerDown(c, 0, 0);
    expect(getPixel(c.buffer, W, H, 0, 0, 1)).toEqual([2]);
    expect(getPixel(c.buffer, W, H, 7, 7, 1)).toEqual([0]); // beyond the wall, untouched
  });
});
