import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllBuffers, getBuffer } from './pixelBuffers';
import { clearAllIndexBuffers, getIndexBuffer } from './indexBuffers';
import {
  allocateCelBuffer,
  bytesPerPixelFor,
  getBufferForBpp,
  getCelBuffer,
  isIndexedLayer,
  releaseCelBuffer,
  resolveRasterToRgba,
  setCelBuffer,
} from './celStorage';
import type { Palette, Sprite } from './types';

beforeEach(() => {
  clearAllBuffers();
  clearAllIndexBuffers();
});

const palette: Palette = { id: 'p', name: 'P', colors: [[10, 20, 30, 255]] };

function sprite(colorMode: Sprite['colorMode']): Sprite {
  return {
    width: 2,
    height: 2,
    colorMode,
    layers: [],
    frames: [],
    cels: [],
    tags: [],
    tilesets: [],
    palette: colorMode === 'indexed' ? palette : undefined,
  };
}

const raster = { kind: 'raster' as const };
const conversion = { kind: 'conversion' as const };
const tilemap = { kind: 'tilemap' as const };

describe('isIndexedLayer / bytesPerPixelFor', () => {
  it('only a raster layer in an indexed sprite is indexed storage', () => {
    expect(isIndexedLayer(sprite('indexed'), raster)).toBe(true);
    expect(isIndexedLayer(sprite('rgba'), raster)).toBe(false);
    expect(isIndexedLayer(sprite('indexed'), conversion)).toBe(false);
    expect(isIndexedLayer(sprite('indexed'), tilemap)).toBe(false);
    expect(bytesPerPixelFor(sprite('indexed'), raster)).toBe(1);
    expect(bytesPerPixelFor(sprite('indexed'), conversion)).toBe(4);
    expect(bytesPerPixelFor(sprite('rgba'), raster)).toBe(4);
  });
});

describe('allocateCelBuffer / getCelBuffer / setCelBuffer / releaseCelBuffer', () => {
  it('routes a raster cel in an rgba sprite to pixelBuffers', () => {
    const s = sprite('rgba');
    const buf = allocateCelBuffer(s, raster, 'c1', 2, 2);
    expect(buf.length).toBe(16);
    expect(getBuffer('c1')).toBe(buf);
    expect(getIndexBuffer('c1')).toBeUndefined();
    expect(getCelBuffer(s, raster, 'c1')).toBe(buf);
    releaseCelBuffer(s, raster, 'c1');
    expect(getBuffer('c1')).toBeUndefined();
  });

  it('routes a raster cel in an indexed sprite to indexBuffers', () => {
    const s = sprite('indexed');
    const buf = allocateCelBuffer(s, raster, 'c2', 2, 2);
    expect(buf.length).toBe(4);
    expect(getIndexBuffer('c2')).toBe(buf);
    expect(getBuffer('c2')).toBeUndefined();
    expect(getCelBuffer(s, raster, 'c2')).toBe(buf);
    releaseCelBuffer(s, raster, 'c2');
    expect(getIndexBuffer('c2')).toBeUndefined();
  });

  it('a conversion layer stays RGBA even in an indexed sprite', () => {
    const s = sprite('indexed');
    const buf = allocateCelBuffer(s, conversion, 'c3', 2, 2);
    expect(buf.length).toBe(16);
    expect(getBuffer('c3')).toBe(buf);
  });

  it('setCelBuffer stores in the correct map for the layer kind', () => {
    const s = sprite('indexed');
    const idx = new Uint8Array([1, 1, 1, 1]);
    setCelBuffer(s, raster, 'c4', idx);
    expect(getIndexBuffer('c4')).toBe(idx);
  });
});

describe('resolveRasterToRgba', () => {
  it('is the identity for an rgba cel', () => {
    const s = sprite('rgba');
    const buf = allocateCelBuffer(s, raster, 'c5', 1, 1);
    expect(resolveRasterToRgba(s, raster, buf, 1, 1)).toBe(buf);
  });

  it('resolves an indexed cel through the sprite palette', () => {
    const s = sprite('indexed');
    const idx = new Uint8Array([1]);
    const rgba = resolveRasterToRgba(s, raster, idx, 1, 1);
    expect([...rgba]).toEqual([10, 20, 30, 255]);
  });
});

describe('getBufferForBpp', () => {
  it('looks up the RGBA store for bpp 4 and the index store for bpp 1', () => {
    const rgbaBuf = new Uint8ClampedArray(4);
    setCelBuffer(sprite('rgba'), raster, 'c6', rgbaBuf);
    expect(getBufferForBpp('c6', 4)).toBe(rgbaBuf);

    const idxBuf = new Uint8Array(1);
    setCelBuffer(sprite('indexed'), raster, 'c7', idxBuf);
    expect(getBufferForBpp('c7', 1)).toBe(idxBuf);
  });
});
