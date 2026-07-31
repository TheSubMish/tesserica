import { beforeEach, describe, expect, it } from 'vitest';
import { getGrid, getGridCell } from '../model/tileGridBuffers';
import { getTileBuffer } from '../model/tileBuffers';
import { EMPTY_TILE_ID, packTileId, tileGridDims } from '../model/tileIds';
import { celBufferId } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { addTileToTileset, addTileset, addTilemapLayer, paintTilemapCell } from './tilesetCommands';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

beforeEach(() => {
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  doc().setActiveLayer(doc().sprite.layers[0].id);
  history().clear();
});

describe('addTileset', () => {
  it('inserts a tileset with a real empty tile at index 0, undoably', () => {
    const id = addTileset('Ground', 8, 8);
    expect(doc().sprite.tilesets).toHaveLength(1);
    expect(doc().sprite.tilesets[0].id).toBe(id);
    expect(doc().sprite.tilesets[0].tiles).toHaveLength(1);

    history().undo();
    expect(doc().sprite.tilesets).toHaveLength(0);

    history().redo();
    expect(doc().sprite.tilesets).toHaveLength(1);
    expect(doc().sprite.tilesets[0].id).toBe(id);
  });
});

describe('addTileToTileset', () => {
  it('appends a tile with the given pixels, undoably', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 1, 1, 1,
    ]);
    const tileId = addTileToTileset(tilesetId, pixels);
    expect(tileId).toBeDefined();

    const tileset = doc().sprite.tilesets.find((t) => t.id === tilesetId)!;
    expect(tileset.tiles).toHaveLength(2);
    expect(tileset.tiles[1].id).toBe(tileId);
    expect(getTileBuffer(tileId!)).toEqual(pixels);

    history().undo();
    expect(doc().sprite.tilesets.find((t) => t.id === tilesetId)!.tiles).toHaveLength(1);

    history().redo();
    expect(doc().sprite.tilesets.find((t) => t.id === tilesetId)!.tiles).toHaveLength(2);
  });

  it('refuses a mis-sized pixel buffer', () => {
    const tilesetId = addTileset('Ground', 4, 4);
    const wrongSize = new Uint8ClampedArray(4); // should be 4*4*4
    expect(addTileToTileset(tilesetId, wrongSize)).toBeUndefined();
    expect(doc().sprite.tilesets.find((t) => t.id === tilesetId)!.tiles).toHaveLength(1);
  });

  it('refuses an unknown tileset', () => {
    expect(addTileToTileset('nope', new Uint8ClampedArray(16))).toBeUndefined();
  });
});

describe('addTilemapLayer', () => {
  it('creates a tilemap layer bound to the tileset, with a grid cel per frame', () => {
    const tilesetId = addTileset('Ground', 8, 8);
    const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
    const layerId = addTilemapLayer(tilesetId, grid, 'Ground Layer');
    expect(layerId).toBeDefined();

    const layer = doc().sprite.layers.find((l) => l.id === layerId);
    expect(layer?.kind).toBe('tilemap');
    if (layer?.kind !== 'tilemap') throw new Error('expected tilemap layer');
    expect(layer.tilesetId).toBe(tilesetId);
    expect(layer.name).toBe('Ground Layer');

    const cels = doc().celsForLayer(layerId!);
    expect(cels).toHaveLength(doc().sprite.frames.length);
    for (const c of cels) {
      const { cols, rows } = tileGridDims(c, grid);
      const g = getGrid(c.id);
      expect(g).toBeDefined();
      expect(g!.length).toBe(cols * rows);
      expect([...g!]).toEqual(new Array(cols * rows).fill(EMPTY_TILE_ID));
    }
  });

  it('refuses an unknown tileset', () => {
    const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
    expect(addTilemapLayer('nope', grid)).toBeUndefined();
  });

  it('undo/redo restores the grid contents exactly (LayerExistence generalized for tilemap)', () => {
    const tilesetId = addTileset('Ground', 8, 8);
    const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
    const layerId = addTilemapLayer(tilesetId, grid)!;
    const cel = doc().celsForLayer(layerId)[0];
    paintTilemapCell(cel.id, 0, 0, packTileId(1));

    history().undo(); // undo the paint
    history().undo(); // undo the layer creation
    expect(doc().sprite.layers.find((l) => l.id === layerId)).toBeUndefined();

    history().redo(); // redo the layer creation
    expect(doc().sprite.layers.find((l) => l.id === layerId)).toBeDefined();
    const restoredCel = doc().celsForLayer(layerId)[0];
    expect(getGrid(restoredCel.id)).toBeDefined();

    history().redo(); // redo the paint
    const layerAfter = doc().sprite.layers.find((l) => l.id === layerId);
    if (layerAfter?.kind !== 'tilemap') throw new Error('expected tilemap');
    const { cols, rows } = tileGridDims(restoredCel, layerAfter.grid);
    expect(getGridCell(getGrid(restoredCel.id)!, cols, rows, 0, 0)).toBe(packTileId(1));
  });
});

describe('paintTilemapCell', () => {
  function setUp() {
    const tilesetId = addTileset('Ground', 8, 8);
    const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(200);
    const tileId = addTileToTileset(tilesetId, pixels)!;
    const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
    const layerId = addTilemapLayer(tilesetId, grid)!;
    const cel = doc().celsForLayer(layerId)[0];
    return { tilesetId, tileId, layerId, cel };
  }

  it('paints a packed tile id into the grid cell, undoably', () => {
    const { cel } = setUp();
    const packed = packTileId(1, { flipH: true });
    paintTilemapCell(cel.id, 1, 0, packed);

    const layer = doc().sprite.layers.find((l) => l.id === cel.layerId);
    if (layer?.kind !== 'tilemap') throw new Error('expected tilemap');
    const { cols, rows } = tileGridDims(cel, layer.grid);
    const grid = getGrid(celBufferId(cel))!;
    expect(getGridCell(grid, cols, rows, 1, 0)).toBe(packed);

    history().undo();
    expect(getGridCell(getGrid(celBufferId(cel))!, cols, rows, 1, 0)).toBe(EMPTY_TILE_ID);

    history().redo();
    expect(getGridCell(getGrid(celBufferId(cel))!, cols, rows, 1, 0)).toBe(packed);
  });

  it('is a silent no-op painting the same tile id twice (no redundant undo step)', () => {
    const { cel } = setUp();
    paintTilemapCell(cel.id, 0, 0, packTileId(1));
    const depthAfterFirst = useHistoryStore.getState().past.length;
    paintTilemapCell(cel.id, 0, 0, packTileId(1));
    expect(useHistoryStore.getState().past.length).toBe(depthAfterFirst);
  });

  it('is a silent no-op out of grid bounds', () => {
    const { cel } = setUp();
    const before = useHistoryStore.getState().past.length;
    paintTilemapCell(cel.id, 999, 999, packTileId(1));
    expect(useHistoryStore.getState().past.length).toBe(before);
  });

  it('does nothing on a non-tilemap cel', () => {
    const raster = doc().sprite.layers[0];
    const rasterCel = doc().celsForLayer(raster.id)[0];
    const before = useHistoryStore.getState().past.length;
    paintTilemapCell(rasterCel.id, 0, 0, packTileId(1));
    expect(useHistoryStore.getState().past.length).toBe(before);
  });
});
