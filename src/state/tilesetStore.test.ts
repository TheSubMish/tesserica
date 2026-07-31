import { beforeEach, describe, expect, it } from 'vitest';
import { packTileId } from '../model/tileIds';
import { useTilesetStore } from './tilesetStore';

beforeEach(() => {
  useTilesetStore.setState({
    selectedTilesetId: null,
    selectedTileIndex: null,
    flipH: false,
    flipV: false,
    transpose: false,
  });
});

describe('tilesetStore', () => {
  it('selects a tile within a tileset', () => {
    useTilesetStore.getState().selectTile('ts1', 3);
    expect(useTilesetStore.getState().selectedTilesetId).toBe('ts1');
    expect(useTilesetStore.getState().selectedTileIndex).toBe(3);
  });

  it('drops the picked tile index when switching to a different tileset', () => {
    useTilesetStore.getState().selectTile('ts1', 3);
    useTilesetStore.getState().setSelectedTileset('ts2');
    expect(useTilesetStore.getState().selectedTilesetId).toBe('ts2');
    expect(useTilesetStore.getState().selectedTileIndex).toBeNull();
  });

  it('keeps the picked tile index when re-selecting the same tileset', () => {
    useTilesetStore.getState().selectTile('ts1', 3);
    useTilesetStore.getState().setSelectedTileset('ts1');
    expect(useTilesetStore.getState().selectedTileIndex).toBe(3);
  });

  it('toggles flip/transpose flags independently', () => {
    useTilesetStore.getState().toggleFlipH();
    expect(useTilesetStore.getState().flipH).toBe(true);
    useTilesetStore.getState().toggleFlipV();
    expect(useTilesetStore.getState().flipV).toBe(true);
    useTilesetStore.getState().toggleTranspose();
    expect(useTilesetStore.getState().transpose).toBe(true);
    // flipH is untouched by the other two toggles.
    expect(useTilesetStore.getState().flipH).toBe(true);
  });

  it('the picked flags feed directly into a packed tile id', () => {
    useTilesetStore.getState().selectTile('ts1', 5);
    useTilesetStore.getState().setFlipH(true);
    useTilesetStore.getState().setTranspose(true);
    const s = useTilesetStore.getState();
    const packed = packTileId(s.selectedTileIndex!, {
      flipH: s.flipH,
      flipV: s.flipV,
      transpose: s.transpose,
    });
    expect(packed).toBe(packTileId(5, { flipH: true, transpose: true }));
  });
});
