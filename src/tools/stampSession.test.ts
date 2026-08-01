/**
 * The Stamp tool's real behaviour (`tools/stamp.ts` is a documented no-op —
 * see that file for why). Exercises `beginStamp`/`continueStamp`/`endStamp`/
 * `abortStamp` against the real document/history stores, the same way
 * `history/tilesetCommands.test.ts` does for the primitives underneath.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { celBufferId } from '../model/types';
import { getGrid, getGridCell } from '../model/tileGridBuffers';
import { EMPTY_TILE_ID, packTileId, tileGridDims } from '../model/tileIds';
import { addTilemapLayer, addTileset, addTileToTileset } from '../history/tilesetCommands';
import { useDocumentStore } from '../state/documentStore';
import { useHistoryStore } from '../state/historyStore';
import { useTilesetStore } from '../state/tilesetStore';
import { abortStamp, beginStamp, continueStamp, endStamp, isStamping } from './stampSession';

const doc = () => useDocumentStore.getState();
const history = () => useHistoryStore.getState();

function setUp() {
  const tilesetId = addTileset('Ground', 8, 8);
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(200);
  addTileToTileset(tilesetId, pixels); // index 1
  const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
  const layerId = addTilemapLayer(tilesetId, grid)!;
  doc().setActiveLayer(layerId);
  const cel = doc().celsForLayer(layerId)[0];
  useTilesetStore.getState().selectTile(tilesetId, 1);
  useTilesetStore.setState({ flipH: false, flipV: false, transpose: false });
  return { tilesetId, layerId, cel, grid };
}

beforeEach(() => {
  history().clear();
  const { width, height } = doc().sprite;
  doc().newDocument(width, height);
  history().clear();
  useTilesetStore.setState({
    selectedTilesetId: null,
    selectedTileIndex: null,
    flipH: false,
    flipV: false,
    transpose: false,
  });
});

describe('beginStamp / continueStamp / endStamp', () => {
  it('does nothing when the active layer is not a tilemap layer', () => {
    expect(beginStamp(0, 0)).toBe(false);
    expect(isStamping()).toBe(false);
  });

  it('does nothing when no tile is picked', () => {
    addTileset('Ground', 8, 8);
    const grid = { shape: 'rect' as const, tileWidth: 8, tileHeight: 8, offsetX: 0, offsetY: 0 };
    const tilesetId = doc().sprite.tilesets[0].id;
    const layerId = addTilemapLayer(tilesetId, grid)!;
    doc().setActiveLayer(layerId);
    expect(beginStamp(0, 0)).toBe(false);
  });

  it('stamps the cell under the pointer at pointer-down, live (before pointer-up)', () => {
    const { cel, grid } = setUp();
    expect(beginStamp(3, 3)).toBe(true); // (3,3) falls in cell (0,0) at tile size 8
    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(packTileId(1));
    endStamp();
  });

  it("bumps the document's reactive revision on every live paint, not just at pointer-up", () => {
    // Regression: a first pass mutated the grid buffer directly without
    // calling `doc.touch()`, so `CanvasView`'s redraw effect (which watches
    // `revision`, not the grid buffer's own separate counter) never re-ran —
    // a stamp was invisible until some unrelated event happened to redraw.
    // Caught by live verification (real click on the real canvas showed no
    // pixel change), not by the grid-content assertions above.
    setUp();
    const before = doc().revision;
    beginStamp(3, 3);
    expect(doc().revision).toBeGreaterThan(before);
    const afterBegin = doc().revision;
    continueStamp(11, 3);
    expect(doc().revision).toBeGreaterThan(afterBegin);
    endStamp();
  });

  it('interpolates cells crossed during a fast drag, like a brush stroke', () => {
    const { cel, grid } = setUp();
    beginStamp(3, 3); // cell (0,0)
    continueStamp(19, 3); // jumps straight to cell (2,0), skipping (1,0)
    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(packTileId(1));
    expect(getGridCell(gridBuffer, cols, rows, 1, 0)).toBe(packTileId(1));
    expect(getGridCell(gridBuffer, cols, rows, 2, 0)).toBe(packTileId(1));
    endStamp();
  });

  it("packs the picker's flip/transpose flags into every cell it paints", () => {
    const { cel, grid } = setUp();
    useTilesetStore.getState().setFlipH(true);
    useTilesetStore.getState().setTranspose(true);
    beginStamp(3, 3);
    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(
      packTileId(1, { flipH: true, transpose: true }),
    );
    endStamp();
  });

  it('closes a multi-cell drag into exactly one undo step', () => {
    const { cel, grid } = setUp();
    const before = history().past.length;
    beginStamp(3, 3);
    continueStamp(11, 3); // cell (1,0)
    continueStamp(19, 11); // cell (2,1)
    endStamp();
    expect(history().past.length).toBe(before + 1);

    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(packTileId(1));
    expect(getGridCell(gridBuffer, cols, rows, 1, 0)).toBe(packTileId(1));
    expect(getGridCell(gridBuffer, cols, rows, 2, 1)).toBe(packTileId(1));

    history().undo();
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(EMPTY_TILE_ID);
    expect(getGridCell(gridBuffer, cols, rows, 1, 0)).toBe(EMPTY_TILE_ID);
    expect(getGridCell(gridBuffer, cols, rows, 2, 1)).toBe(EMPTY_TILE_ID);

    history().redo();
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(packTileId(1));
  });

  it('pushes no undo step at all for a click that changes nothing (re-stamping the same tile)', () => {
    const { cel } = setUp();
    beginStamp(3, 3);
    endStamp();
    const before = history().past.length;

    beginStamp(3, 3); // same cell, same tile id — a no-op gesture
    endStamp();
    expect(history().past.length).toBe(before);
    void cel;
  });
});

function setUpIsometric() {
  const tilesetId = addTileset('Iso Ground', 4, 2);
  const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(200);
  addTileToTileset(tilesetId, pixels); // index 1
  const grid = { shape: 'isometric' as const, tileWidth: 4, tileHeight: 2, offsetX: 0, offsetY: 0 };
  const layerId = addTilemapLayer(tilesetId, grid)!;
  doc().setActiveLayer(layerId);
  const cel = doc().celsForLayer(layerId)[0];
  useTilesetStore.getState().selectTile(tilesetId, 1);
  useTilesetStore.setState({ flipH: false, flipV: false, transpose: false });
  return { tilesetId, layerId, cel, grid };
}

describe('beginStamp on an isometric grid', () => {
  it('targets the diamond cell under the pointer, not the rect cell at the same pixel', () => {
    const { cel, grid } = setUpIsometric();
    // cellOrigin(2, 1) = ((2-1)*4/2, (2+1)*2/2) = (2, 3); its centre is
    // (2+2, 3+1) = (4, 4) — clicking there must target (col=2, row=1), which
    // plain rect division at this tile size (floor(4/4)=1, floor(4/2)=2)
    // would have targeted instead.
    expect(beginStamp(4, 4)).toBe(true);
    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 2, 1)).toBe(packTileId(1));
    expect(getGridCell(gridBuffer, cols, rows, 1, 2)).toBe(EMPTY_TILE_ID);
    endStamp();
  });
});

describe('abortStamp', () => {
  it('reverts every cell the gesture touched and pushes no undo step', () => {
    const { cel, grid } = setUp();
    const before = history().past.length;
    beginStamp(3, 3);
    continueStamp(11, 3);
    abortStamp();

    expect(isStamping()).toBe(false);
    expect(history().past.length).toBe(before);
    const { cols, rows } = tileGridDims(cel, grid);
    const gridBuffer = getGrid(celBufferId(cel))!;
    expect(getGridCell(gridBuffer, cols, rows, 0, 0)).toBe(EMPTY_TILE_ID);
    expect(getGridCell(gridBuffer, cols, rows, 1, 0)).toBe(EMPTY_TILE_ID);
  });
});
