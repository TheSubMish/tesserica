import { describe, expect, it } from 'vitest';
import { getPixel, setPixel } from '../model/pixelBuffers';
import type { RGBA } from '../model/types';
import { fillContiguous, fillGlobal } from './fill';
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
