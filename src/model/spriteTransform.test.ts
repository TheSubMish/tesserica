import { describe, expect, it } from 'vitest';

import { anchorOffset, opSize, resizeBuffer, transformBuffer } from './spriteTransform';

// 3×2 indexed image:  1 2 3
//                     4 5 6
const IMG = new Uint8Array([1, 2, 3, 4, 5, 6]);

describe('transformBuffer', () => {
  it('flips horizontally and vertically', () => {
    expect([...transformBuffer(IMG, 3, 2, 1, 'flip-h')]).toEqual([3, 2, 1, 6, 5, 4]);
    expect([...transformBuffer(IMG, 3, 2, 1, 'flip-v')]).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('rotates clockwise and counter-clockwise, swapping the dimensions', () => {
    expect(opSize('rot-cw', 3, 2)).toEqual({ width: 2, height: 3 });
    // clockwise: first column read bottom-to-top becomes the first row
    expect([...transformBuffer(IMG, 3, 2, 1, 'rot-cw')]).toEqual([4, 1, 5, 2, 6, 3]);
    expect([...transformBuffer(IMG, 3, 2, 1, 'rot-ccw')]).toEqual([3, 6, 2, 5, 1, 4]);
    expect([...transformBuffer(IMG, 3, 2, 1, 'rot-180')]).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('four clockwise turns, or two flips on one axis, are the identity', () => {
    let b: Uint8Array | Uint8ClampedArray = IMG;
    let w = 3;
    let h = 2;
    for (let i = 0; i < 4; i++) {
      b = transformBuffer(b, w, h, 1, 'rot-cw');
      [w, h] = [h, w];
    }
    expect([...b]).toEqual([...IMG]);
    const twice = transformBuffer(transformBuffer(IMG, 3, 2, 1, 'flip-h'), 3, 2, 1, 'flip-h');
    expect([...twice]).toEqual([...IMG]);
  });

  it('moves whole RGBA pixels, never splitting channels, and keeps the array type', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]); // two pixels
    const out = transformBuffer(rgba, 2, 1, 4, 'flip-h');
    expect([...out]).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(transformBuffer(IMG, 3, 2, 1, 'flip-h')).toBeInstanceOf(Uint8Array);
  });

  it('does not modify its input', () => {
    const copy = new Uint8Array(IMG);
    transformBuffer(IMG, 3, 2, 1, 'rot-cw');
    expect([...IMG]).toEqual([...copy]);
  });
});

describe('anchorOffset', () => {
  it('places the old image per anchor', () => {
    expect(anchorOffset('tl', 4, 4, 8, 6)).toEqual({ x: 0, y: 0 });
    expect(anchorOffset('br', 4, 4, 8, 6)).toEqual({ x: 4, y: 2 });
    expect(anchorOffset('c', 4, 4, 8, 6)).toEqual({ x: 2, y: 1 });
    expect(anchorOffset('tr', 4, 4, 8, 6)).toEqual({ x: 4, y: 0 });
  });

  it('goes negative when shrinking, so the far side is what gets cropped', () => {
    expect(anchorOffset('br', 8, 8, 4, 4)).toEqual({ x: -4, y: -4 });
    expect(anchorOffset('tl', 8, 8, 4, 4)).toEqual({ x: 0, y: 0 });
  });
});

describe('resizeBuffer', () => {
  it('grows with transparent padding at the offset', () => {
    const out = resizeBuffer(new Uint8Array([9, 9, 9, 9]), 2, 2, 1, 4, 3, 1, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 9, 9, 0, 0, 9, 9, 0]);
  });

  it('crops when the offset is negative', () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 3×3
    expect([...resizeBuffer(src, 3, 3, 1, 2, 2, -1, -1)]).toEqual([5, 6, 8, 9]);
  });

  it('returns an empty-but-sized buffer when nothing overlaps', () => {
    const out = resizeBuffer(new Uint8Array([1, 2, 3, 4]), 2, 2, 1, 2, 2, 5, 5);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('handles 4-byte pixels', () => {
    const src = new Uint8ClampedArray([1, 2, 3, 4]);
    const out = resizeBuffer(src, 1, 1, 4, 2, 1, 1, 0);
    expect([...out]).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
  });
});
