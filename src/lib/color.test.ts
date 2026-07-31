import { describe, expect, it } from 'vitest';
import { fromHex, sameRgb, toCss, toHex } from './color';

describe('toHex', () => {
  it('encodes RGB, uppercase, alpha omitted', () => {
    expect(toHex([255, 0, 128, 255])).toBe('#FF0080');
  });
});

describe('fromHex', () => {
  it('is the inverse of toHex, alpha supplied separately', () => {
    expect(fromHex('#FF0080', 255)).toEqual([255, 0, 128, 255]);
  });

  it('accepts lowercase and a missing leading #', () => {
    expect(fromHex('ff0080', 128)).toEqual([255, 0, 128, 128]);
  });

  it('falls back to opaque black on malformed input rather than throwing', () => {
    expect(fromHex('not-a-color', 200)).toEqual([0, 0, 0, 200]);
  });
});

describe('toCss', () => {
  it('renders straight alpha as a 0..1 CSS alpha', () => {
    expect(toCss([10, 20, 30, 255])).toBe('rgba(10,20,30,1)');
    expect(toCss([10, 20, 30, 0])).toBe('rgba(10,20,30,0)');
  });
});

describe('sameRgb', () => {
  it('ignores alpha', () => {
    expect(sameRgb([1, 2, 3, 255], [1, 2, 3, 0])).toBe(true);
    expect(sameRgb([1, 2, 3, 255], [1, 2, 4, 255])).toBe(false);
  });
});
