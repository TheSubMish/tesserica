import { beforeEach, describe, expect, it } from 'vitest';
import { allocateGrid, setGridCell } from './tileGridBuffers';
import { clearAllTileBuffers, setTileBuffer } from './tileBuffers';
import { packTileId } from './tileIds';
import {
  flipTileH,
  flipTileV,
  renderTilemapCel,
  resolveTilePixels,
  transposeTile,
} from './tilemapRender';
import type { GridSpec, Tileset } from './types';

const grid: GridSpec = { shape: 'rect', tileWidth: 2, tileHeight: 2, offsetX: 0, offsetY: 0 };

/** A 2×2 tile with four distinct, recognisable corners: TL red, TR green, BL blue, BR white. */
function cornerTile(): Uint8ClampedArray {
  return new Uint8ClampedArray([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255, //
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
  ]);
}

beforeEach(() => {
  clearAllTileBuffers();
});

describe('flipTileH / flipTileV / transposeTile', () => {
  it('flipH mirrors columns, keeping rows in place', () => {
    const flipped = flipTileH(cornerTile(), 2, 2);
    // TL<->TR, BL<->BR
    expect([...flipped.slice(0, 4)]).toEqual([0, 255, 0, 255]); // was TR (green)
    expect([...flipped.slice(4, 8)]).toEqual([255, 0, 0, 255]); // was TL (red)
    expect([...flipped.slice(8, 12)]).toEqual([255, 255, 255, 255]); // was BR (white)
    expect([...flipped.slice(12, 16)]).toEqual([0, 0, 255, 255]); // was BL (blue)
  });

  it('flipV mirrors rows, keeping columns in place', () => {
    const flipped = flipTileV(cornerTile(), 2, 2);
    expect([...flipped.slice(0, 4)]).toEqual([0, 0, 255, 255]); // was BL (blue)
    expect([...flipped.slice(4, 8)]).toEqual([255, 255, 255, 255]); // was BR (white)
    expect([...flipped.slice(8, 12)]).toEqual([255, 0, 0, 255]); // was TL (red)
    expect([...flipped.slice(12, 16)]).toEqual([0, 255, 0, 255]); // was TR (green)
  });

  it('transpose reflects across the main diagonal on a square tile', () => {
    const t = transposeTile(cornerTile(), 2, 2);
    // TL stays, TR<->BL, BR stays.
    expect([...t.slice(0, 4)]).toEqual([255, 0, 0, 255]); // TL unchanged
    expect([...t.slice(4, 8)]).toEqual([0, 0, 255, 255]); // now BL's old colour
    expect([...t.slice(8, 12)]).toEqual([0, 255, 0, 255]); // now TR's old colour
    expect([...t.slice(12, 16)]).toEqual([255, 255, 255, 255]); // BR unchanged
  });

  it('transpose is a documented no-op on a non-square tile', () => {
    const rect = new Uint8ClampedArray(2 * 1 * 4).fill(9);
    expect(transposeTile(rect, 2, 1)).toBe(rect);
  });
});

describe('resolveTilePixels', () => {
  it('returns null for an out-of-range tile index', () => {
    const tileset: Tileset = { id: 'ts1', name: 't', tileWidth: 2, tileHeight: 2, tiles: [] };
    expect(resolveTilePixels(tileset, packTileId(3))).toBeNull();
  });

  it('applies flip flags on top of the resolved buffer', () => {
    setTileBuffer('tile-a', cornerTile());
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'tile-a' }],
    };
    const flipped = resolveTilePixels(tileset, packTileId(1, { flipH: true }))!;
    expect([...flipped.slice(0, 4)]).toEqual([0, 255, 0, 255]);
  });
});

describe('renderTilemapCel', () => {
  it('blits each grid cell into place, nearest-neighbour (pixel-exact, no scaling)', () => {
    setTileBuffer(
      'solid-red',
      new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]),
    );
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'solid-red' }],
    };
    const cel = { width: 4, height: 2 };
    const gridBuf = allocateGrid('c1', 2, 1);
    setGridCell(gridBuf, 2, 1, 1, 0, packTileId(1)); // right cell only

    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    // Left 2×2 cell (index 0, empty) stays transparent.
    expect(out.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 0]));
    // Right 2×2 cell is opaque red.
    const rightPixel = (0 * cel.width + 2) * 4;
    expect([...out.slice(rightPixel, rightPixel + 4)]).toEqual([255, 0, 0, 255]);
  });

  it('renders a flipped tile pixel-exact within its cell', () => {
    setTileBuffer('corner', cornerTile());
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'corner' }],
    };
    const cel = { width: 2, height: 2 };
    const gridBuf = allocateGrid('c2', 1, 1);
    setGridCell(gridBuf, 1, 1, 0, 0, packTileId(1, { flipH: true }));

    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    // Unflipped TL was red; flipped TL should be green (old TR).
    expect([...out.slice(0, 4)]).toEqual([0, 255, 0, 255]);
    // Flipped TR should be red (old TL).
    expect([...out.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it('renders fully transparent when the tileset or grid is missing', () => {
    const cel = { width: 2, height: 2 };
    expect(renderTilemapCel(undefined, grid, allocateGrid('c3', 1, 1), cel)).toEqual(
      new Uint8ClampedArray(16),
    );
    const tileset: Tileset = { id: 'ts1', name: 't', tileWidth: 2, tileHeight: 2, tiles: [] };
    expect(renderTilemapCel(tileset, grid, undefined, cel)).toEqual(new Uint8ClampedArray(16));
  });

  it('clips a partial trailing tile at the cel edge rather than overwriting adjacent memory', () => {
    setTileBuffer('solid', new Uint8ClampedArray(16).fill(200));
    const tileset: Tileset = {
      id: 'ts1',
      name: 't',
      tileWidth: 2,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'solid' }],
    };
    // A 3-wide cel with 2px tiles: tileGridDims floors to 1 column, so the
    // trailing column is simply never drawn — no out-of-bounds write.
    const cel = { width: 3, height: 2 };
    const gridBuf = allocateGrid('c4', 1, 1);
    setGridCell(gridBuf, 1, 1, 0, 0, packTileId(1));
    const out = renderTilemapCel(tileset, grid, gridBuf, cel);
    expect(out.length).toBe(3 * 2 * 4);
  });
});

/** A solid opaque `w`×`h` tile of one flat colour. */
function solidTile(w: number, h: number, rgba: readonly [number, number, number, number]) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) buf.set(rgba, i * 4);
  return buf;
}

function pixelAt(buf: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

describe('renderTilemapCel — isometric placement', () => {
  const isoGrid: GridSpec = {
    shape: 'isometric',
    tileWidth: 4,
    tileHeight: 2,
    offsetX: 0,
    offsetY: 0,
  };

  it('places (1,0) half a tile right and half a tile down from (0,0), matching cellOrigin', () => {
    setTileBuffer('red', solidTile(4, 2, [255, 0, 0, 255]));
    setTileBuffer('blue', solidTile(4, 2, [0, 0, 255, 255]));
    const tileset: Tileset = {
      id: 'ts',
      name: 't',
      tileWidth: 4,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'red' }, { id: 'blue' }],
    };
    // cel big enough for tile A (0,0)..(4,2) and tile B (2,1)..(6,3).
    const cel = { width: 8, height: 4 };
    const gridBuf = allocateGrid('iso1', 2, 2);
    setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1)); // red at (0,0)
    setGridCell(gridBuf, 2, 2, 1, 0, packTileId(2)); // blue at (1,0)

    const out = renderTilemapCel(tileset, isoGrid, gridBuf, cel);

    // Pure-A region: top-left corner, only inside tile A's box.
    expect(pixelAt(out, cel.width, 0, 0)).toEqual([255, 0, 0, 255]);
    // Pure-B region: x=5,y=2 is inside B's box (x:[2,6), y:[1,3)) but outside
    // A's box (x:[0,4), y:[0,2)).
    expect(pixelAt(out, cel.width, 5, 2)).toEqual([0, 0, 255, 255]);
    // Overlap region (x:[2,4), y:[1,2)): both tiles' opaque bounding boxes
    // cover it — the later-drawn (higher col+row, "closer to the viewer")
    // tile wins, i.e. blue.
    expect(pixelAt(out, cel.width, 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it('draws back-to-front by col+row so a higher-depth tile always wins an overlap, regardless of insertion order', () => {
    setTileBuffer('red', solidTile(4, 2, [255, 0, 0, 255]));
    setTileBuffer('blue', solidTile(4, 2, [0, 0, 255, 255]));
    const tileset: Tileset = {
      id: 'ts',
      name: 't',
      tileWidth: 4,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'red' }, { id: 'blue' }],
    };
    const cel = { width: 8, height: 4 };
    const gridBuf = allocateGrid('iso2', 2, 2);
    // Same cells as above, but written in the opposite (col, row) order —
    // tileDrawOrder must sort by depth, not rely on grid storage order.
    setGridCell(gridBuf, 2, 2, 1, 0, packTileId(2)); // blue at (1,0), depth 1
    setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1)); // red at (0,0), depth 0

    const out = renderTilemapCel(tileset, isoGrid, gridBuf, cel);
    expect(pixelAt(out, cel.width, 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it('alpha-composites overlapping tiles rather than a flat overwrite', () => {
    setTileBuffer('opaqueBlue', solidTile(4, 2, [0, 0, 255, 255]));
    setTileBuffer('translucentRed', solidTile(4, 2, [255, 0, 0, 128]));
    const tileset: Tileset = {
      id: 'ts',
      name: 't',
      tileWidth: 4,
      tileHeight: 2,
      tiles: [{ id: 'empty' }, { id: 'opaqueBlue' }, { id: 'translucentRed' }],
    };
    const cel = { width: 8, height: 4 };
    const gridBuf = allocateGrid('iso3', 2, 2);
    setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1)); // opaque blue, depth 0
    setGridCell(gridBuf, 2, 2, 1, 0, packTileId(2)); // translucent red, depth 1

    const out = renderTilemapCel(tileset, isoGrid, gridBuf, cel);
    const overlap = pixelAt(out, cel.width, 3, 1);
    // Neither pure blue nor pure red — a real blend, and fully opaque
    // (opaque backdrop + any source alpha stays opaque under source-over).
    expect(overlap).not.toEqual([0, 0, 255, 255]);
    expect(overlap).not.toEqual([255, 0, 0, 128]);
    expect(overlap[0]).toBeGreaterThan(0); // red channel pulled up from 0
    expect(overlap[2]).toBeGreaterThan(0); // blue channel still present
    expect(overlap[3]).toBe(255); // opaque backdrop stays opaque
  });
});

describe('renderTilemapCel — hexagonal placement (pointy-top, odd-r)', () => {
  const hexGrid: GridSpec = {
    shape: 'hexagonal',
    tileWidth: 4,
    tileHeight: 4,
    offsetX: 0,
    offsetY: 0,
  };

  it('offsets odd rows right by half a tile width and steps rows by 3/4 tile height', () => {
    setTileBuffer('red', solidTile(4, 4, [255, 0, 0, 255]));
    setTileBuffer('green', solidTile(4, 4, [0, 255, 0, 255]));
    setTileBuffer('blue', solidTile(4, 4, [0, 0, 255, 255]));
    const tileset: Tileset = {
      id: 'ts',
      name: 't',
      tileWidth: 4,
      tileHeight: 4,
      tiles: [{ id: 'empty' }, { id: 'red' }, { id: 'green' }, { id: 'blue' }],
    };
    // height 8, not 7, so `tileGridDims` (a plain `floor(cel.height / tileHeight)`
    // division — deliberately shape-agnostic, see `model/gridGeometry.ts`'s
    // module doc) reports 2 usable rows and row 1 is a valid grid address;
    // the hex row step itself is still the fractional 3/4 tile height below.
    const cel = { width: 8, height: 8 };
    const gridBuf = allocateGrid('hex1', 2, 2);
    setGridCell(gridBuf, 2, 2, 0, 0, packTileId(1)); // red, box x:[0,4) y:[0,4)
    setGridCell(gridBuf, 2, 2, 1, 0, packTileId(2)); // green, box x:[4,8) y:[0,4)
    setGridCell(gridBuf, 2, 2, 0, 1, packTileId(3)); // blue, box x:[2,6) y:[3,7)

    const out = renderTilemapCel(tileset, hexGrid, gridBuf, cel);

    // Same-row tiles never overlap: pure red and pure green corners.
    expect(pixelAt(out, cel.width, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, cel.width, 7, 0)).toEqual([0, 255, 0, 255]);
    // Pure-blue region: inside (0,1)'s box only (x:[2,6), y:[3,7)) — e.g.
    // (2,6) is outside both row-0 boxes (y >= 4).
    expect(pixelAt(out, cel.width, 2, 6)).toEqual([0, 0, 255, 255]);
    // Row 1 is drawn after row 0, so it wins any overlap — e.g. (3,3) sits
    // inside both red's box (x:[0,4),y:[0,4)) and blue's box.
    expect(pixelAt(out, cel.width, 3, 3)).toEqual([0, 0, 255, 255]);
    // (5,3) sits inside both green's box (x:[4,8),y:[0,4)) and blue's box
    // (x:[2,6),y:[3,7)) — blue (row 1) should still win.
    expect(pixelAt(out, cel.width, 5, 3)).toEqual([0, 0, 255, 255]);
  });
});
