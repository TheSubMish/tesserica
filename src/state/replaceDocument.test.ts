import { describe, expect, it } from 'vitest';
import { getBuffer, getPixel } from '../model/pixelBuffers';
import { getGrid, getGridCell } from '../model/tileGridBuffers';
import { getTileBuffer } from '../model/tileBuffers';
import { packTileId } from '../model/tileIds';
import type { Sprite } from '../model/types';
import { useDocumentStore } from './documentStore';

const doc = () => useDocumentStore.getState();

/**
 * A document shaped exactly as a `.tess` load hands it back.
 *
 * Deliberately omits `tags` (cast at the end) — a `.tess` saved before tags
 * existed has no such field on the wire, and `replaceDocument` must default
 * it rather than hand back `undefined` for the Timeline panel to trip over.
 */
function loaded(): Sprite {
  return {
    width: 4,
    height: 4,
    layers: [
      {
        id: 'l1',
        kind: 'raster',
        name: 'bg',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        parentId: null,
        clippingMask: false,
      },
      {
        id: 'l2',
        kind: 'raster',
        name: 'ink',
        visible: true,
        locked: false,
        opacity: 0.5,
        blendMode: 'normal',
        parentId: null,
        clippingMask: false,
      },
    ],
    frames: [{ id: 'f1', durationMs: 100 }],
    cels: [
      { id: 'c1', layerId: 'l1', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 },
      { id: 'c2', layerId: 'l2', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 },
    ],
  } as unknown as Sprite;
}

describe('replaceDocument', () => {
  it('installs the loaded sprite, its pixels and a sane selection', () => {
    const pixels = new Map<string, Uint8ClampedArray>();
    const c1 = new Uint8ClampedArray(4 * 4 * 4);
    c1.set([1, 2, 3, 255], 0);
    pixels.set('c1', c1);

    doc().replaceDocument(loaded(), pixels);

    const s = doc();
    expect(s.sprite.layers.map((l) => l.name)).toEqual(['bg', 'ink']);
    // Top layer is selected, which is where an artist expects to be.
    expect(s.activeLayerId).toBe('l2');
    expect(s.activeFrameId).toBe('f1');
    expect(getPixel(getBuffer('c1')!, 4, 4, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('allocates a blank buffer for a cel whose pixels are missing', () => {
    // Rust warns and omits the cel when its PNG is absent; the layer must still
    // open, empty, rather than the document failing.
    doc().replaceDocument(loaded(), new Map());
    expect(getBuffer('c2')).toBeDefined();
    expect(getBuffer('c2')!.every((v) => v === 0)).toBe(true);
  });

  it('rejects a buffer whose length does not match the cel', () => {
    const pixels = new Map<string, Uint8ClampedArray>([['c1', new Uint8ClampedArray(8)]]);
    doc().replaceDocument(loaded(), pixels);
    expect(getBuffer('c1')).toHaveLength(4 * 4 * 4);
  });

  it('does not keep the previous document’s buffers alive', () => {
    doc().addLayer('doomed');
    const stale = doc().celsForLayer(doc().activeLayerId)[0].id;
    expect(getBuffer(stale)).toBeDefined();

    doc().replaceDocument(loaded(), new Map());
    expect(getBuffer(stale)).toBeUndefined();
  });

  it('never mints an id that collides with one it just loaded', () => {
    // The loaded ids came from another run of the generator. Handing out `c2`
    // again would give two layers the same pixel buffer.
    doc().replaceDocument(loaded(), new Map());
    doc().addLayer('after');

    const ids = [...doc().sprite.layers.map((l) => l.id), ...doc().sprite.cels.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults tags to an empty array when the loaded sprite has none', () => {
    doc().replaceDocument(loaded(), new Map());
    expect(doc().sprite.tags).toEqual([]);
  });

  it('tracks the project path so Save can write back without asking', () => {
    doc().setProjectPath('/tmp/x.tess');
    expect(doc().projectPath).toBe('/tmp/x.tess');
    doc().setProjectPath(null);
    expect(doc().projectPath).toBeNull();
  });

  it('loads a linked cel without allocating a buffer of its own', () => {
    // Exactly what Rust hands back for a `.tess` with two frames on one
    // layer where the second links to the first (`docs/03-data-model.md`
    // §2.2): only the canonical cel ("c1") comes with pixels.
    const sprite: Sprite = {
      ...loaded(),
      frames: [...loaded().frames, { id: 'f2', durationMs: 100 }],
      cels: [
        ...loaded().cels,
        { id: 'c3', layerId: 'l1', frameId: 'f2', x: 0, y: 0, width: 4, height: 4, linkedTo: 'c1' },
      ],
    };
    const c1 = new Uint8ClampedArray(4 * 4 * 4);
    c1.set([9, 8, 7, 255], 0);
    const pixels = new Map<string, Uint8ClampedArray>([['c1', c1]]);

    doc().replaceDocument(sprite, pixels);

    expect(getBuffer('c3')).toBeUndefined();
    // The link resolves through `c1`, which the renderer/tools do via
    // `celBufferId` — asserted here at the buffer layer this store owns.
    expect(getPixel(getBuffer('c1')!, 4, 4, 0, 0)).toEqual([9, 8, 7, 255]);
  });

  describe('tilesets and tilemap-layer grids (roadmap Phase 6, `.tess` round trip)', () => {
    /**
     * Exactly the shape `app/project.ts::openProject` hands `replaceDocument`
     * after a real `load_project` IPC round trip: a tilemap layer's cel, a
     * tileset with two tiles, `grids`/`tileBuffers` maps keyed the same way
     * `pixels` already is.
     */
    function loadedWithTilemap(): Sprite {
      return {
        width: 4,
        height: 4,
        layers: [
          {
            id: 'tm1',
            kind: 'tilemap',
            name: 'Ground',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            parentId: null,
            clippingMask: false,
            tilesetId: 'ts1',
            grid: { shape: 'rect', tileWidth: 2, tileHeight: 2, offsetX: 0, offsetY: 0 },
          },
        ],
        frames: [{ id: 'f1', durationMs: 100 }],
        cels: [{ id: 'cel-tm', layerId: 'tm1', frameId: 'f1', x: 0, y: 0, width: 4, height: 4 }],
        tilesets: [
          {
            id: 'ts1',
            name: 'Ground',
            tileWidth: 2,
            tileHeight: 2,
            tiles: [{ id: 'empty' }, { id: 'grass' }],
          },
        ],
      } as unknown as Sprite;
    }

    it('installs the tileset metadata, the tile pixels, and the grid content', () => {
      const grassPixels = new Uint8ClampedArray(2 * 2 * 4).fill(77);
      const tileBuffers = new Map<string, Uint8ClampedArray>([['grass', grassPixels]]);
      const grid = new Uint32Array([0, 1, 1, 0]); // 2x2 grid of tile ids
      const grids = new Map<string, Uint32Array>([['cel-tm', grid]]);

      doc().replaceDocument(loadedWithTilemap(), new Map(), grids, tileBuffers);

      expect(doc().sprite.tilesets).toHaveLength(1);
      expect(doc().sprite.tilesets[0].tiles).toHaveLength(2);
      expect(getTileBuffer('grass')).toEqual(grassPixels);

      const loadedGrid = getGrid('cel-tm')!;
      expect(loadedGrid).toBeDefined();
      expect(getGridCell(loadedGrid, 2, 2, 1, 0)).toBe(1);
      expect(getGridCell(loadedGrid, 2, 2, 0, 0)).toBe(0);
    });

    it('allocates a real (transparent) buffer for a tile whose pixels are missing', () => {
      // Mirrors the missing-cel-PNG fallback: a missing tile PNG warns on the
      // Rust side and the tile opens blank rather than the whole document
      // failing to load.
      doc().replaceDocument(loadedWithTilemap(), new Map(), new Map(), new Map());
      expect(getTileBuffer('empty')).toBeDefined();
      expect(getTileBuffer('empty')!.every((v) => v === 0)).toBe(true);
      expect(getTileBuffer('grass')).toBeDefined();
      expect(getTileBuffer('grass')!.every((v) => v === 0)).toBe(true);
    });

    it('allocates an empty grid (all tile id 0) for a tilemap cel whose grid is missing', () => {
      doc().replaceDocument(loadedWithTilemap(), new Map(), new Map(), new Map());
      const grid = getGrid('cel-tm')!;
      expect(grid).toBeDefined();
      expect(grid.length).toBe(4); // a 4x4 cel / 2x2 tiles = 2x2 grid
      expect([...grid]).toEqual([0, 0, 0, 0]);
    });

    it('rejects a grid whose length does not match the cel’s tile-grid dimensions', () => {
      const wrongSize = new Map<string, Uint32Array>([['cel-tm', new Uint32Array(1)]]);
      doc().replaceDocument(loadedWithTilemap(), new Map(), wrongSize, new Map());
      expect(getGrid('cel-tm')).toHaveLength(4);
    });

    it('defaults tilesets to an empty array when the loaded sprite has none', () => {
      doc().replaceDocument(loaded(), new Map());
      expect(doc().sprite.tilesets).toEqual([]);
    });

    it('creating a tilemap layer + painting a cell survives a full save/load round trip through replaceDocument', () => {
      // Not a real IPC call, but exercises the exact same seam
      // `app/project.ts` marshals through: build the document with real
      // commands, snapshot its buffers the way `saveCurrentProject` does,
      // then feed them back through `replaceDocument` the way `openProject`
      // does, and confirm the result is indistinguishable from the original.
      doc().newDocument(4, 4);

      const grid = new Uint32Array([0, 0, 0, packTileId(1, { flipH: true })]);
      const tileBuffers = new Map<string, Uint8ClampedArray>([
        ['empty', new Uint8ClampedArray(16)],
        ['grass', new Uint8ClampedArray(16).fill(9)],
      ]);
      const sprite = {
        ...loadedWithTilemap(),
        width: 4,
        height: 4,
      };
      const grids = new Map<string, Uint32Array>([['cel-tm', grid]]);

      doc().replaceDocument(sprite, new Map(), grids, tileBuffers);

      const roundTrippedGrid = getGrid('cel-tm')!;
      expect(getGridCell(roundTrippedGrid, 2, 2, 1, 1)).toBe(packTileId(1, { flipH: true }));
      expect(getTileBuffer('grass')).toEqual(new Uint8ClampedArray(16).fill(9));
    });
  });
});
