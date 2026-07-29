import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allocateBuffer,
  bumpCelRevision,
  clearAllBuffers,
  getBuffer,
  setPixel,
} from '../model/pixelBuffers';
import type { Cel, Sprite } from '../model/types';
import {
  drawCheckerboard,
  drawGrid,
  drawOnionSkin,
  drawSelection,
  drawSprite,
  invalidateRenderCache,
  ONION_TINT_FUTURE,
  ONION_TINT_PAST,
} from './renderer';

/**
 * jsdom has no 2D context and no `ImageData`, so the renderer is exercised
 * against a recording stub. That is enough for what matters here: these tests
 * are about *which calls* the renderer makes — nearest-neighbour scaling, a
 * screen-space checkerboard, one grid line per document column — not about the
 * pixels a real rasterizer would produce.
 */

interface Call {
  fn: string;
  args: unknown[];
  /** Snapshotted at call time — plain-property state (`fillStyle`,
   *  `globalAlpha`) is not itself an argument, so tests that care which tint
   *  or opacity was active for a given draw need it captured then, not read
   *  off the context afterwards when only the last value would remain. */
  fillStyle?: string;
  globalAlpha?: number;
}

function stubContext() {
  const calls: Call[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      // `ctx` is referenced, not yet assigned, at the moment each of these
      // closures is *created* below — safe, because none of them run until
      // a test calls them, by which point the `const ctx = {...}` assignment
      // has long since completed.
      calls.push({ fn, args, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha });
    };

  const ctx = {
    calls,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    strokeStyle: '',
    lineWidth: 0,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    drawImage: record('drawImage'),
    putImageData: record('putImageData'),
    setLineDash: record('setLineDash'),
    lineDashOffset: 0,
  };
  return ctx;
}

type StubContext = ReturnType<typeof stubContext>;

/** Route every canvas the renderer creates internally to a stub context too. */
function stubCanvasFactory() {
  const contexts: StubContext[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const ctx = stubContext();
    contexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  });
  return contexts;
}

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

const g = globalThis as { ImageData?: unknown };
g.ImageData ??= FakeImageData;

function makeSprite(width: number, height: number): Sprite {
  allocateBuffer('cel', width, height);
  return {
    width,
    height,
    layers: [
      {
        id: 'l1',
        kind: 'raster',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        parentId: null,
        clippingMask: false,
      },
    ],
    frames: [{ id: 'f1', durationMs: 100 }],
    cels: [{ id: 'cel', layerId: 'l1', frameId: 'f1', x: 0, y: 0, width, height }],
  };
}

beforeEach(() => {
  clearAllBuffers();
  // The renderer caches across calls by design; every test here starts from a
  // cold cache so it measures its own work, not the previous test's.
  invalidateRenderCache();
});

describe('drawSprite', () => {
  it('disables image smoothing before blitting — nearest-neighbour is invariant 1', () => {
    stubCanvasFactory();
    const ctx = stubContext();
    drawSprite(ctx as unknown as CanvasRenderingContext2D, makeSprite(8, 8), 'f1', {
      zoom: 16,
      panX: 0,
      panY: 0,
    });
    expect(ctx.imageSmoothingEnabled).toBe(false);
  });

  it('blits the composite at pan, scaled by an integer zoom', () => {
    stubCanvasFactory();
    const ctx = stubContext();
    drawSprite(ctx as unknown as CanvasRenderingContext2D, makeSprite(16, 12), 'f1', {
      zoom: 8,
      panX: 40,
      panY: 25,
    });

    const blit = ctx.calls.filter((c) => c.fn === 'drawImage');
    expect(blit).toHaveLength(1);
    expect(blit[0].args.slice(1)).toEqual([40, 25, 128, 96]);
  });

  it('composites at document scale, so the cost does not grow with zoom', () => {
    // 4096 source pixels get pushed whether the view is at 1x or 64x; only the
    // final blit is zoom-sized.
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(64, 64);
    const ctx = stubContext();

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', {
      zoom: 64,
      panX: 0,
      panY: 0,
    });

    const put = contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'putImageData');
    expect(put).toHaveLength(1);
    const image = put[0].args[0] as FakeImageData;
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
  });

  it('skips hidden layers', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(4, 4);
    sprite.layers[0].visible = false;
    const ctx = stubContext();

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', {
      zoom: 4,
      panX: 0,
      panY: 0,
    });

    expect(contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'putImageData')).toHaveLength(0);
  });

  it('passes the layer buffer through untouched — straight alpha, not premultiplied', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(2, 2);
    const buf = allocateBuffer('cel', 2, 2);
    setPixel(buf, 2, 2, 0, 0, [255, 0, 0, 128]);
    const ctx = stubContext();

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', {
      zoom: 4,
      panX: 0,
      panY: 0,
    });

    const put = contexts.flatMap((c) => c.calls).find((c) => c.fn === 'putImageData');
    const image = put!.args[0] as FakeImageData;
    expect(Array.from(image.data.slice(0, 4))).toEqual([255, 0, 0, 128]);
  });
});

describe('dirty-layer caching', () => {
  it('does not re-upload anything when nothing changed', () => {
    // Pan, zoom, grid toggling and cursor movement all force a redraw while
    // the artwork is untouched. Those redraws must cost a blit, not an upload.
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(16, 16);
    const ctx = stubContext();
    const vp = { zoom: 4, panX: 0, panY: 0 };

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', vp);
    const afterFirst = contexts
      .flatMap((c) => c.calls)
      .filter((c) => c.fn === 'putImageData').length;

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', { ...vp, panX: 40 });
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', { ...vp, zoom: 32 });

    expect(afterFirst).toBe(1);
    expect(contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'putImageData')).toHaveLength(1);
    // The blit still happens every time — the frame is still drawn.
    expect(ctx.calls.filter((c) => c.fn === 'drawImage')).toHaveLength(3);
  });

  it('re-uploads only the cel whose pixels changed', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(8, 8);
    // A second layer, so there is something that must *not* be re-uploaded.
    allocateBuffer('cel2', 8, 8);
    sprite.layers.push({ ...sprite.layers[0], id: 'l2', name: 'Layer 2' });
    sprite.cels.push({ id: 'cel2', layerId: 'l2', frameId: 'f1', x: 0, y: 0, width: 8, height: 8 });

    const ctx = stubContext();
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', {
      zoom: 4,
      panX: 0,
      panY: 0,
    });
    expect(contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'putImageData')).toHaveLength(2);

    // Edit one cel and redraw.
    setPixel(getBuffer('cel2')!, 8, 8, 1, 1, [1, 2, 3, 255]);
    bumpCelRevision('cel2');
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', {
      zoom: 4,
      panX: 0,
      panY: 0,
    });

    // Three uploads total: two cold, one for the cel that changed.
    expect(contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'putImageData')).toHaveLength(3);
  });

  it('re-uploads a cel that becomes linked even when the two revision numbers coincide', () => {
    // Regression: `celCanvas`'s cache used to key solely on the numeric
    // revision, not on *which buffer* produced it. Two cels each edited
    // exactly once both sit at revision 1 — a `Link Cel` (docs/03-data-model.md
    // §2.2) that repoints one at the other's buffer must still force a
    // re-upload, not silently keep showing the pre-link pixels because "1 ===
    // 1" looked unchanged.
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(8, 8);
    allocateBuffer('cel2', 8, 8);
    sprite.layers.push({ ...sprite.layers[0], id: 'l2', name: 'Layer 2' });
    const cel2: Cel = { id: 'cel2', layerId: 'l2', frameId: 'f1', x: 0, y: 0, width: 8, height: 8 };
    sprite.cels.push(cel2);

    // One edit each — both land on revision 1.
    setPixel(getBuffer('cel')!, 8, 8, 0, 0, [10, 20, 30, 255]);
    bumpCelRevision('cel');
    setPixel(getBuffer('cel2')!, 8, 8, 7, 7, [40, 50, 60, 255]);
    bumpCelRevision('cel2');

    const ctx = stubContext();
    const vp = { zoom: 4, panX: 0, panY: 0 };
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', vp);
    const uploadsBefore = contexts
      .flatMap((c) => c.calls)
      .filter((c) => c.fn === 'putImageData').length;
    expect(uploadsBefore).toBe(2); // one per cel, cold cache

    // Link cel2 to cel's buffer — its resolved bufferId changes from 'cel2'
    // to 'cel', whose revision also happens to be 1.
    cel2.linkedTo = 'cel';
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', vp);

    const uploadsAfter = contexts
      .flatMap((c) => c.calls)
      .filter((c) => c.fn === 'putImageData').length;
    expect(uploadsAfter).toBeGreaterThan(uploadsBefore);
  });

  it('recomposites when a layer property changes without any pixel changing', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeSprite(8, 8);
    const ctx = stubContext();
    const vp = { zoom: 4, panX: 0, panY: 0 };

    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', vp);
    const scratchCalls = () => contexts.flatMap((c) => c.calls).filter((c) => c.fn === 'drawImage');
    const before = scratchCalls().length;

    sprite.layers[0].opacity = 0.5;
    drawSprite(ctx as unknown as CanvasRenderingContext2D, sprite, 'f1', vp);
    expect(scratchCalls().length).toBeGreaterThan(before);
  });
});

describe('drawSelection', () => {
  it('draws two offset dashed strokes, not one — colour alone must not carry the state', () => {
    const ctx = stubContext();
    drawSelection(
      ctx as unknown as CanvasRenderingContext2D,
      { zoom: 4, panX: 0, panY: 0 },
      { bounds: { x: 1, y: 1, width: 2, height: 3 } },
    );

    const strokeCalls = ctx.calls.filter((c) => c.fn === 'stroke');
    expect(strokeCalls).toHaveLength(2);

    const moveTos = ctx.calls.filter((c) => c.fn === 'moveTo');
    // A rect has 4 edges, walked once per pass (black, then white).
    expect(moveTos).toHaveLength(8);
    // Same path both times — zoom applied, pan applied.
    expect(moveTos.slice(0, 4)).toEqual(moveTos.slice(4));
    expect(moveTos[0].args).toEqual([4.5, 4.5]);
  });

  it('draws nothing for an empty selection', () => {
    const ctx = stubContext();
    drawSelection(
      ctx as unknown as CanvasRenderingContext2D,
      { zoom: 4, panX: 0, panY: 0 },
      { bounds: { x: 0, y: 0, width: 0, height: 0 } },
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it("outlines a mask's real boundary, not its bounding box", () => {
    // An L-tromino — the top-left three cells of a 2×2 square, corner cell
    // unselected. A rectangle outline would be wrong here.
    const mask = new Uint8Array([1, 1, 1, 0]);
    const ctx = stubContext();
    drawSelection(
      ctx as unknown as CanvasRenderingContext2D,
      { zoom: 1, panX: 0, panY: 0 },
      { bounds: { x: 0, y: 0, width: 2, height: 2 }, mask },
    );
    // Perimeter of an L-tromino is 8 unit edges (3 squares × 4 sides, minus
    // the 2 interior edges shared between adjacent selected cells).
    const moveTos = ctx.calls.filter((c) => c.fn === 'moveTo');
    expect(moveTos).toHaveLength(16); // 8 edges × 2 passes
  });
});

describe('drawCheckerboard', () => {
  it('uses fixed 8px screen-space squares (docs/05-ui-design.md §6.3)', () => {
    const ctx = stubContext();
    drawCheckerboard(ctx as unknown as CanvasRenderingContext2D, 0, 0, 32, 32);

    // First fillRect is the background wash; the rest are the dark squares.
    const squares = ctx.calls.filter((c) => c.fn === 'fillRect').slice(1);
    expect(squares.length).toBeGreaterThan(0);
    for (const s of squares) {
      expect(s.args[2]).toBe(8);
      expect(s.args[3]).toBe(8);
    }
  });

  it('does not scale the squares with zoom', () => {
    // A zoom-scaled checkerboard reads as artwork at high zoom, so the caller
    // passes only the sprite's screen rect and the square size stays put.
    const a = stubContext();
    const b = stubContext();
    drawCheckerboard(a as unknown as CanvasRenderingContext2D, 0, 0, 64, 64);
    drawCheckerboard(b as unknown as CanvasRenderingContext2D, 0, 0, 64, 64);

    const sizes = (c: StubContext) =>
      new Set(
        c.calls
          .filter((x) => x.fn === 'fillRect')
          .slice(1)
          .map((x) => `${x.args[2]}`),
      );
    expect(sizes(a)).toEqual(new Set(['8']));
    expect(sizes(b)).toEqual(new Set(['8']));
  });
});

describe('drawGrid', () => {
  it('draws one line per document column and row, plus the closing edge', () => {
    const ctx = stubContext();
    const sprite = makeSprite(4, 3);
    drawGrid(ctx as unknown as CanvasRenderingContext2D, sprite, { zoom: 8, panX: 0, panY: 0 });

    // 4 columns → 5 verticals, 3 rows → 4 horizontals.
    expect(ctx.calls.filter((c) => c.fn === 'moveTo')).toHaveLength(9);
  });

  it('offsets strokes by half a pixel so 1px lines stay crisp', () => {
    const ctx = stubContext();
    drawGrid(ctx as unknown as CanvasRenderingContext2D, makeSprite(2, 2), {
      zoom: 10,
      panX: 3,
      panY: 7,
    });

    const verticals = ctx.calls.filter((c) => c.fn === 'moveTo').slice(0, 3);
    expect(verticals.map((c) => c.args[0])).toEqual([3.5, 13.5, 23.5]);
  });
});

describe('drawOnionSkin', () => {
  /** One independent cel per frame, all on a single layer. */
  function makeAnimatedSprite(width: number, height: number, frameCount: number): Sprite {
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      id: `f${i + 1}`,
      durationMs: 100,
    }));
    const cels: Cel[] = frames.map((f, i) => {
      const id = `cel${i + 1}`;
      allocateBuffer(id, width, height);
      return { id, layerId: 'l1', frameId: f.id, x: 0, y: 0, width, height };
    });
    return {
      width,
      height,
      layers: [
        {
          id: 'l1',
          kind: 'raster',
          name: 'Layer 1',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'normal',
          parentId: null,
          clippingMask: false,
        },
      ],
      frames,
      cels,
    };
  }

  it('draws nothing when there are no ghosts', () => {
    stubCanvasFactory();
    const sprite = makeAnimatedSprite(4, 4, 3);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 4, panX: 0, panY: 0 },
      [],
    );

    expect(ctx.calls).toHaveLength(0);
  });

  it('tints an earlier frame red and a later frame blue', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeAnimatedSprite(4, 4, 3);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 4, panX: 0, panY: 0 },
      [
        { frameId: 'f1', distance: -1 },
        { frameId: 'f3', distance: 1 },
      ],
    );

    const tints = contexts
      .flatMap((c) => c.calls)
      .filter((c) => c.fn === 'fillRect')
      .map((c) => c.fillStyle);
    expect(tints).toEqual([ONION_TINT_PAST, ONION_TINT_FUTURE]);
  });

  it('recolours via source-atop, keeping the composite’s own alpha shape', () => {
    const contexts = stubCanvasFactory();
    const sprite = makeAnimatedSprite(4, 4, 2);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 4, panX: 0, panY: 0 },
      [{ frameId: 'f2', distance: 1 }],
    );

    // The internal ghost canvas draws the frame's own composite first, then
    // fills with the tint — `source-atop` on the fill call is what turns a
    // full-rect fill into "only where the composite already had coverage".
    const ghostContext = contexts.find((c) => c.calls.some((call) => call.fn === 'fillRect'))!;
    const drawThenFill = ghostContext.calls.filter(
      (c) => c.fn === 'drawImage' || c.fn === 'fillRect',
    );
    expect(drawThenFill.map((c) => c.fn)).toEqual(['drawImage', 'fillRect']);
  });

  it('fades opacity with distance from the active frame', () => {
    stubCanvasFactory();
    const sprite = makeAnimatedSprite(4, 4, 5);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 4, panX: 0, panY: 0 },
      [
        { frameId: 'f2', distance: -1 },
        { frameId: 'f1', distance: -2 },
      ],
    );

    const blits = ctx.calls.filter((c) => c.fn === 'drawImage');
    expect(blits).toHaveLength(2);
    expect(blits[0].globalAlpha).toBeGreaterThan(blits[1].globalAlpha!);
    expect(blits[0].globalAlpha).toBeGreaterThan(0);
    expect(blits[1].globalAlpha).toBeGreaterThan(0);
  });

  it('resets globalAlpha to 1 once every ghost is drawn', () => {
    stubCanvasFactory();
    const sprite = makeAnimatedSprite(4, 4, 3);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 4, panX: 0, panY: 0 },
      [
        { frameId: 'f1', distance: -1 },
        { frameId: 'f3', distance: 1 },
      ],
    );

    expect(ctx.globalAlpha).toBe(1);
  });

  it('blits each ghost at pan and integer zoom, like the active frame', () => {
    stubCanvasFactory();
    const sprite = makeAnimatedSprite(8, 6, 2);
    const ctx = stubContext();

    drawOnionSkin(
      ctx as unknown as CanvasRenderingContext2D,
      sprite,
      { zoom: 5, panX: 12, panY: 9 },
      [{ frameId: 'f2', distance: 1 }],
    );

    const blit = ctx.calls.find((c) => c.fn === 'drawImage')!;
    expect(blit.args.slice(1)).toEqual([12, 9, 40, 30]);
  });
});
