import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllTileBuffers, getTileBuffer } from './tileBuffers';
import { createTileset } from './tilesets';

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
