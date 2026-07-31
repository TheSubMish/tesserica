import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllBuffers } from '../model/pixelBuffers';
import { clearAllGrids } from '../model/tileGridBuffers';
import { clearAllTileBuffers, getTileBuffer } from '../model/tileBuffers';
import { packTileId } from '../model/tileIds';
import {
  addTileset,
  addTileToTileset,
  addTilemapLayer,
  paintTilemapCell,
} from '../history/tilesetCommands';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import {
  concatTilePixels,
  DEFAULT_TILESET_SHEET_COLUMNS,
  tilemapExportSelection,
} from './tilemapExport';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

const solidTile = (color: [number, number, number, number], w: number, h: number) => {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) buf.set(color, i * 4);
  return buf;
};

beforeEach(() => {
  clearAllBuffers();
  clearAllGrids();
  clearAllTileBuffers();
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  doc().setActiveLayer(doc().sprite.layers[0].id);
  history().clear();
});

describe('tilemapExportSelection', () => {
  it('resolves the tileset, grid dimensions and packed tile ids for a tilemap layer', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const red = solidTile([255, 0, 0, 255], 2, 2);
    const outcome = addTileToTileset(tilesetId, red)!;

    const layerId = addTilemapLayer(tilesetId, {
      shape: 'rect',
      tileWidth: 2,
      tileHeight: 2,
      offsetX: 0,
      offsetY: 0,
    })!;

    const frameId = doc().sprite.frames[0].id;
    const cel = doc().sprite.cels.find((c) => c.layerId === layerId && c.frameId === frameId)!;
    paintTilemapCell(cel.id, 0, 0, packTileId(outcome.index));

    const selection = tilemapExportSelection(doc().sprite, layerId, frameId);
    expect(selection).toBeDefined();
    expect(selection!.tileset.id).toBe(tilesetId);
    expect(selection!.cols).toBeGreaterThan(0);
    expect(selection!.rows).toBeGreaterThan(0);
    expect(selection!.tileIds[0]).toBe(packTileId(outcome.index));
  });

  it('is undefined for a non-tilemap layer', () => {
    const rasterLayerId = doc().sprite.layers[0].id;
    const frameId = doc().sprite.frames[0].id;
    expect(tilemapExportSelection(doc().sprite, rasterLayerId, frameId)).toBeUndefined();
  });

  it('is undefined for an unknown layer id', () => {
    const frameId = doc().sprite.frames[0].id;
    expect(tilemapExportSelection(doc().sprite, 'nope', frameId)).toBeUndefined();
  });

  it('is undefined when the tilemap layer has no cel at the given frame', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const layerId = addTilemapLayer(tilesetId, {
      shape: 'rect',
      tileWidth: 2,
      tileHeight: 2,
      offsetX: 0,
      offsetY: 0,
    })!;
    expect(tilemapExportSelection(doc().sprite, layerId, 'no-such-frame')).toBeUndefined();
  });
});

describe('concatTilePixels', () => {
  it('concatenates every real tile in ascending index order, skipping the empty tile', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const red = solidTile([255, 0, 0, 255], 2, 2);
    const green = solidTile([0, 255, 0, 255], 2, 2);
    addTileToTileset(tilesetId, red);
    addTileToTileset(tilesetId, green);

    const tileset = doc().sprite.tilesets.find((t) => t.id === tilesetId)!;
    expect(tileset.tiles).toHaveLength(3); // empty + red + green

    const atlas = concatTilePixels(tileset)!;
    expect(atlas.count).toBe(2);
    expect(atlas.pixels).toHaveLength(2 * 2 * 2 * 4);
    // First real tile (red) occupies the first 16 bytes, in order.
    expect(Array.from(atlas.pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(atlas.pixels.subarray(16, 20))).toEqual([0, 255, 0, 255]);
  });

  it('produces a zero-count atlas for a tileset with only the empty tile', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const tileset = doc().sprite.tilesets.find((t) => t.id === tilesetId)!;
    const atlas = concatTilePixels(tileset)!;
    expect(atlas.count).toBe(0);
    expect(atlas.pixels).toHaveLength(0);
  });

  it('is undefined when a real tile is missing its own pixel buffer', () => {
    const tilesetId = addTileset('Ground', 2, 2);
    const red = solidTile([255, 0, 0, 255], 2, 2);
    const outcome = addTileToTileset(tilesetId, red)!;
    const tileset = doc().sprite.tilesets.find((t) => t.id === tilesetId)!;

    // Simulate a corrupt/missing tile buffer without changing the tileset shape.
    clearAllTileBuffers();
    expect(getTileBuffer(outcome.id)).toBeUndefined();
    expect(concatTilePixels(tileset)).toBeUndefined();
  });
});

describe('DEFAULT_TILESET_SHEET_COLUMNS', () => {
  it('is a small, sane default', () => {
    expect(DEFAULT_TILESET_SHEET_COLUMNS).toBeGreaterThan(0);
  });
});
