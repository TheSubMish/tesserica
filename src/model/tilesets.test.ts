import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllTileBuffers, getTileBuffer, setTileBuffer } from './tileBuffers';
import { createTileset, extractTilePixels, findMatchingTile, tilePixelsEqual } from './tilesets';
import type { Tileset } from './types';

beforeEach(() => {
  clearAllTileBuffers();
});

describe('createTileset', () => {
  it('starts with exactly one tile, index 0, the mandatory empty tile', () => {
    let n = 0;
    const makeId = () => `id${n++}`;
    const ts = createTileset(makeId, 'Ground', 16, 16);
    expect(ts.name).toBe('Ground');
    expect(ts.tileWidth).toBe(16);
    expect(ts.tileHeight).toBe(16);
    expect(ts.tiles).toHaveLength(1);
  });

  it('allocates a real, fully transparent buffer for the empty tile', () => {
    let n = 0;
    const makeId = () => `id${n++}`;
    const ts = createTileset(makeId, 'Ground', 4, 4);
    const buf = getTileBuffer(ts.tiles[0].id);
    expect(buf).toBeDefined();
    expect(buf).toEqual(new Uint8ClampedArray(4 * 4 * 4));
  });
});

describe('extractTilePixels', () => {
  // 4x3 buffer, straight alpha, distinct bytes so a crop's origin is verifiable.
  const width = 4;
  const height = 3;
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 256;

  it('crops a rect out of a larger buffer', () => {
    const out = extractTilePixels(buffer, width, height, { x: 1, y: 1, width: 2, height: 2 });
    expect(out).toBeDefined();
    expect(out).toHaveLength(2 * 2 * 4);
    // Row 0 of the crop is buffer's row 1, columns 1..2.
    const rowStart = (1 * width + 1) * 4;
    expect(out!.subarray(0, 8)).toEqual(buffer.subarray(rowStart, rowStart + 8));
  });

  it('returns undefined when the rect does not fit inside the buffer', () => {
    expect(
      extractTilePixels(buffer, width, height, { x: 3, y: 0, width: 2, height: 1 }),
    ).toBeUndefined();
    expect(
      extractTilePixels(buffer, width, height, { x: -1, y: 0, width: 2, height: 1 }),
    ).toBeUndefined();
    expect(
      extractTilePixels(buffer, width, height, { x: 0, y: 0, width: 0, height: 1 }),
    ).toBeUndefined();
  });
});

describe('findMatchingTile', () => {
  function tileset(entries: Uint8ClampedArray[], tileWidth = 2, tileHeight = 1): Tileset {
    return {
      id: 'ts',
      name: 'T',
      tileWidth,
      tileHeight,
      tiles: entries.map((buf, i) => {
        const id = `tile${i}`;
        setTileBuffer(id, buf);
        return { id };
      }),
    };
  }

  it('matches an exact pixel copy', () => {
    const a = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const ts = tileset([a]);
    const match = findMatchingTile(ts, new Uint8ClampedArray(a));
    expect(match).toEqual({ index: 0, flipH: false, flipV: false });
  });

  it('matches a horizontally-flipped copy and reports flipH', () => {
    const a = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const flippedA = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255]);
    const ts = tileset([a]);
    expect(findMatchingTile(ts, flippedA)).toEqual({ index: 0, flipH: true, flipV: false });
  });

  it('returns undefined when nothing matches, even under a flip', () => {
    const a = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const unrelated = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const ts = tileset([a]);
    expect(findMatchingTile(ts, unrelated)).toBeUndefined();
  });

  it('skips a tile with a size mismatch rather than throwing', () => {
    const a = new Uint8ClampedArray(8);
    const ts = tileset([a]);
    const wrongSize = new Uint8ClampedArray(4);
    expect(findMatchingTile(ts, wrongSize)).toBeUndefined();
  });
});

describe('tilePixelsEqual', () => {
  it('is true only for identical bytes', () => {
    const a = new Uint8ClampedArray([1, 2, 3, 4]);
    expect(tilePixelsEqual(a, new Uint8ClampedArray([1, 2, 3, 4]))).toBe(true);
    expect(tilePixelsEqual(a, new Uint8ClampedArray([1, 2, 3, 5]))).toBe(false);
    expect(tilePixelsEqual(a, new Uint8ClampedArray([1, 2, 3]))).toBe(false);
  });
});
