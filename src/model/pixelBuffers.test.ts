import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateBuffer,
  clearAllBuffers,
  getBuffer,
  getPixel,
  releaseBuffer,
  setPixel,
} from './pixelBuffers';

beforeEach(() => {
  clearAllBuffers();
});

describe('buffer registry', () => {
  it('allocates a fully transparent RGBA buffer of the right length', () => {
    const buf = allocateBuffer('c1', 4, 3);
    expect(buf).toHaveLength(4 * 3 * 4);
    expect(buf.every((v) => v === 0)).toBe(true);
  });

  it('hands back the same buffer instance, not a copy', () => {
    // Tools mutate the buffer in place and only bump `revision`; a copy here
    // would mean strokes silently never reach the renderer.
    const buf = allocateBuffer('c1', 2, 2);
    expect(getBuffer('c1')).toBe(buf);
  });

  it('forgets released buffers', () => {
    allocateBuffer('c1', 2, 2);
    releaseBuffer('c1');
    expect(getBuffer('c1')).toBeUndefined();
  });
});

describe('setPixel / getPixel', () => {
  it('writes straight, non-premultiplied alpha', () => {
    // A half-transparent red must keep r=255. Premultiplying would store ~128
    // and cause fringing once the palette quantizer sees it (invariant 3).
    const buf = allocateBuffer('c1', 2, 2);
    setPixel(buf, 2, 2, 0, 0, [255, 0, 0, 128]);
    expect(getPixel(buf, 2, 2, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('writes at the right offset for a non-square buffer', () => {
    const buf = allocateBuffer('c1', 5, 3);
    setPixel(buf, 5, 3, 3, 2, [1, 2, 3, 4]);
    // Row-major: (2 * 5 + 3) * 4 = 52.
    expect(Array.from(buf.slice(52, 56))).toEqual([1, 2, 3, 4]);
    expect(getPixel(buf, 5, 3, 3, 2)).toEqual([1, 2, 3, 4]);
  });

  it('ignores out-of-bounds writes instead of wrapping to the next row', () => {
    const buf = allocateBuffer('c1', 4, 4);
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [4, 0],
      [0, 4],
      [99, 99],
    ]) {
      setPixel(buf, 4, 4, x, y, [255, 255, 255, 255]);
    }
    expect(buf.every((v) => v === 0)).toBe(true);
  });

  it('returns null rather than a wrapped pixel when reading out of bounds', () => {
    const buf = allocateBuffer('c1', 4, 4);
    expect(getPixel(buf, 4, 4, -1, 0)).toBeNull();
    expect(getPixel(buf, 4, 4, 4, 0)).toBeNull();
    expect(getPixel(buf, 4, 4, 0, 4)).toBeNull();
  });
});
