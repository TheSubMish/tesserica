/**
 * Canvas compositing and overlays.
 *
 * Canvas2D, per `docs/02-architecture.md` §7 — WebGL2 is deferred until
 * measurement justifies it (Q8, decided in Phase 4).
 *
 * Layer stack drawn here:
 *   1. checkerboard transparency background
 *   2. composited layers
 *   3. grid overlay
 *   4. cursor cell preview
 */

import type { Cel, CelId, Layer, LayerId, Sprite } from '../model/types';
import { celRevision, getBuffer } from '../model/pixelBuffers';
import { childrenOf } from '../model/layerTree';
import { canvasCompositeOp } from './blend';
import type { Viewport } from './coords';
import { selectionEdges, type Selection } from '../model/selection';

/**
 * Fixed 8px in *screen* space, deliberately not scaled by zoom
 * (docs/05-ui-design.md §6.3) — a zoom-scaled checkerboard reads as artwork at
 * high zoom.
 */
const CHECKER_SIZE = 8;
const CHECKER_A = '#2a2a30';
const CHECKER_B = '#232329';

/** Reused across frames so we are not reallocating a canvas per redraw. */
let scratch: HTMLCanvasElement | null = null;

function getScratch(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}

// ---------------------------------------------------------------------------
// Dirty-layer caching (docs/02-architecture.md §7)
//
// Two levels, because there are two distinct kinds of wasted work:
//
//  1. **Per-cel.** `putImageData` is an upload. Without a cache, one pencil dot
//     on the top layer re-uploads every layer beneath it on every pointer
//     event. Each cel therefore keeps its own canvas, refreshed only when that
//     cel's revision moves.
//  2. **Whole composite.** Pan, zoom, grid toggling and cursor movement all
//     force a redraw while the artwork is completely unchanged. A signature
//     over the layer stack lets those redraws reuse the previous composite and
//     do nothing but blit.
// ---------------------------------------------------------------------------

interface CelCacheEntry {
  canvas: HTMLCanvasElement;
  revision: number;
  width: number;
  height: number;
}

const celCache = new Map<CelId, CelCacheEntry>();
let compositeSignature: string | null = null;

/** Drop every cache. Called when the document is replaced wholesale. */
export function invalidateRenderCache(): void {
  celCache.clear();
  compositeSignature = null;
  canvasPool.clear();
}

/**
 * What the composite depends on. Anything not in here must not be able to
 * change the output, or the cache will serve a stale frame.
 *
 * Recurses into groups — a change to a nested layer must still invalidate
 * the top-level composite, since the group it lives in is redrawn as part of
 * the same pass. `collapsed` is deliberately excluded: it only affects the
 * layer *panel's* display, never the canvas.
 */
function signatureOf(sprite: Sprite, frameId: string): string {
  const parts: string[] = [`${sprite.width}x${sprite.height}@${frameId}`];
  const walk = (parentId: LayerId | null): void => {
    for (const layer of childrenOf(sprite.layers, parentId)) {
      const cel =
        layer.kind === 'group'
          ? undefined
          : sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
      parts.push(
        `${layer.id}:${layer.visible ? 1 : 0}:${layer.opacity}:${layer.blendMode}:` +
          `${layer.clippingMask ? 1 : 0}:` +
          `${layer.kind === 'group' ? 'G' : cel ? `${cel.id}@${cel.x},${cel.y}#${celRevision(cel.id)}` : '-'}`,
      );
      if (layer.kind === 'group') walk(layer.id);
    }
  };
  walk(null);
  return parts.join('|');
}

/** The cel's pixels on their own canvas, re-uploaded only when they changed. */
function celCanvas(cel: Cel): HTMLCanvasElement | null {
  const buf = getBuffer(cel.id);
  if (!buf) return null;

  const revision = celRevision(cel.id);
  const cached = celCache.get(cel.id);
  if (cached && cached.revision === revision) return cached.canvas;

  const canvas = cached?.canvas ?? document.createElement('canvas');
  if (canvas.width !== cel.width || canvas.height !== cel.height) {
    canvas.width = cel.width;
    canvas.height = cel.height;
  }
  // Fetched per call rather than cached: a stored context outlives canvas
  // resizes and test doubles, and getting it again is cheap.
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, cel.width, cel.height);
  ctx.putImageData(new ImageData(buf, cel.width, cel.height), 0, 0);

  celCache.set(cel.id, { canvas, revision, width: cel.width, height: cel.height });
  return canvas;
}

/** Forget cels the document no longer contains. */
function pruneCelCache(sprite: Sprite): void {
  if (celCache.size <= sprite.cels.length) return;
  const live = new Set(sprite.cels.map((c) => c.id));
  for (const id of celCache.keys()) {
    if (!live.has(id)) celCache.delete(id);
  }
}

function isDrawable(layer: Layer): boolean {
  return layer.visible && layer.opacity > 0;
}

// ---------------------------------------------------------------------------
// Group nesting + clipping masks (`docs/08-roadmap.md` Phase 3, "Layer
// groups, clipping masks")
//
// A group renders its children onto an isolated canvas — transparent
// backdrop, its own clip stack — then that canvas is composited into whatever
// is beneath the group exactly like a raster layer's cel would be, using the
// group's *own* opacity and blend mode. Clipping masks reuse the same
// "isolated contribution" idea: a clipped layer is masked by the nearest
// non-clipping layer's own alpha (not the running composite's), scoped to
// one group's children and never crossing into a parent or child scope.
//
// Canvases are pooled by a `${purpose}:${depth}` key rather than allocated
// per layer. Recursion here is a synchronous depth-first walk, and every
// pooled canvas is fully consumed (drawn into its caller) before the next
// sibling at the same depth could recycle it, so reuse is safe and the pool
// stays bounded by nesting depth, not layer count.
// ---------------------------------------------------------------------------

const canvasPool = new Map<string, HTMLCanvasElement>();

function pooled(key: string, w: number, h: number): CanvasRenderingContext2D {
  let c = canvasPool.get(key);
  if (!c) {
    c = document.createElement('canvas');
    canvasPool.set(key, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * Composite one scope — the top-level stack when `parentId` is `null`, or
 * one group's children otherwise (`model/layerTree.ts`) — onto a pooled
 * canvas sized to the whole sprite, and return it.
 */
function compositeScope(
  sprite: Sprite,
  frameId: string,
  parentId: LayerId | null,
  depth: number,
): HTMLCanvasElement {
  const { width: w, height: h } = sprite;
  const sctx = pooled(`scope:${depth}`, w, h);

  /** The nearest non-clipping layer's own contribution, at its own opacity. */
  let baseCtx: CanvasRenderingContext2D | null = null;

  for (const layer of childrenOf(sprite.layers, parentId)) {
    if (!isDrawable(layer)) continue;

    let source: HTMLCanvasElement | null;
    let offsetX = 0;
    let offsetY = 0;
    if (layer.kind === 'group') {
      source = compositeScope(sprite, frameId, layer.id, depth + 1);
    } else {
      const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
      if (!cel) continue;
      source = celCanvas(cel);
      offsetX = cel.x;
      offsetY = cel.y;
    }
    if (!source) continue;

    if (layer.clippingMask) {
      if (!baseCtx) continue; // nothing below to clip to in this scope
      const clipCtx = pooled(`clip:${depth}`, w, h);
      clipCtx.globalAlpha = layer.opacity;
      clipCtx.drawImage(source, offsetX, offsetY);
      clipCtx.globalAlpha = 1;
      // Keep only where the base layer's own shape has alpha.
      clipCtx.globalCompositeOperation = 'destination-in';
      clipCtx.drawImage(baseCtx.canvas, 0, 0);
      clipCtx.globalCompositeOperation = 'source-over';

      sctx.globalCompositeOperation = canvasCompositeOp(layer.blendMode);
      sctx.drawImage(clipCtx.canvas, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
    } else {
      sctx.globalAlpha = layer.opacity;
      sctx.globalCompositeOperation = canvasCompositeOp(layer.blendMode);
      sctx.drawImage(source, offsetX, offsetY);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';

      // This layer becomes the base for any clip layers stacked above it —
      // snapshot its isolated contribution now, before `source` (a pooled
      // group canvas, if this is a group) can be recycled by a later sibling.
      baseCtx = pooled(`base:${depth}`, w, h);
      baseCtx.globalAlpha = layer.opacity;
      baseCtx.drawImage(source, offsetX, offsetY);
      baseCtx.globalAlpha = 1;
    }
  }

  return sctx.canvas;
}

export function drawCheckerboard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = CHECKER_B;
  const startCol = Math.floor(x / CHECKER_SIZE);
  const startRow = Math.floor(y / CHECKER_SIZE);
  const endCol = Math.ceil((x + w) / CHECKER_SIZE);
  const endRow = Math.ceil((y + h) / CHECKER_SIZE);

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      if ((row + col) % 2 === 0) continue;
      ctx.fillRect(col * CHECKER_SIZE, row * CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
    }
  }
  ctx.restore();
}

/**
 * Composite visible layers into an offscreen canvas at 1:1 document scale,
 * then blit it scaled with smoothing disabled.
 *
 * Compositing at document scale rather than screen scale means the cost is
 * independent of zoom — at 64× a 64×64 sprite still composites 4096 pixels,
 * not 16 million.
 */
export function compositeSprite(sprite: Sprite, frameId: string): HTMLCanvasElement {
  const canvas = getScratch(sprite.width, sprite.height);

  const signature = signatureOf(sprite, frameId);
  if (signature === compositeSignature) return canvas;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, sprite.width, sprite.height);

  // `putImageData` ignores `globalAlpha`, so layer opacity has to come from
  // `drawImage` off the cel's own canvas. Straight alpha is preserved:
  // Canvas2D's source-over on unassociated ImageData is what we want, and no
  // premultiplication is introduced anywhere on this path.
  //
  // Blend modes beyond normal use the browser's native
  // `globalCompositeOperation` here rather than `blend.ts`'s per-pixel maths
  // — this is the live *preview* half of the hybrid split
  // (`docs/02-architecture.md` §3), already "deliberately approximate", and
  // the names are literally the CSS/Canvas blend-mode keywords
  // (`canvasCompositeOp`). Export (`flatten.ts`) and the eyedropper
  // (`samplePixel`) use the hand-rolled W3C formulas directly, since those
  // are the paths that must be exact. Groups and clipping masks are resolved
  // recursively in `compositeScope`, but the leaf-layer drawing rules above
  // are unchanged.
  const composited = compositeScope(sprite, frameId, null, 0);
  ctx.drawImage(composited, 0, 0);

  pruneCelCache(sprite);
  compositeSignature = signature;
  return canvas;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  frameId: string,
  vp: Viewport,
): void {
  const composited = compositeSprite(sprite, frameId);

  // Nearest-neighbour is non-negotiable for pixel art
  // (docs/02-architecture.md §9).
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(composited, vp.panX, vp.panY, sprite.width * vp.zoom, sprite.height * vp.zoom);
}

export function drawGrid(ctx: CanvasRenderingContext2D, sprite: Sprite, vp: Viewport): void {
  const w = sprite.width * vp.zoom;
  const h = sprite.height * vp.zoom;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  // The 0.5 offset puts strokes on pixel centers so 1px lines stay crisp.
  for (let x = 0; x <= sprite.width; x++) {
    const sx = Math.round(vp.panX + x * vp.zoom) + 0.5;
    ctx.moveTo(sx, vp.panY);
    ctx.lineTo(sx, vp.panY + h);
  }
  for (let y = 0; y <= sprite.height; y++) {
    const sy = Math.round(vp.panY + y * vp.zoom) + 0.5;
    ctx.moveTo(vp.panX, sy);
    ctx.lineTo(vp.panX + w, sy);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawBorder(ctx: CanvasRenderingContext2D, sprite: Sprite, vp: Viewport): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(vp.panX) - 0.5,
    Math.round(vp.panY) - 0.5,
    sprite.width * vp.zoom + 1,
    sprite.height * vp.zoom + 1,
  );
  ctx.restore();
}

/**
 * The active selection, drawn as marching ants (`docs/08-roadmap.md` Phase 3).
 *
 * Two offset dashed strokes, black and white, rather than one colour — a
 * single-colour dashed line disappears against art of the same colour, and
 * "never encode state in colour alone" (`docs/05-ui-design.md` §8) applies to
 * the selection outline as much as anything else in the UI.
 *
 * Walks the mask's actual boundary edges (`model/selection.ts#selectionEdges`)
 * rather than the bounding box, so ellipse, lasso and magic-wand selections
 * outline their real shape instead of a rectangle around it.
 */
export function drawSelection(ctx: CanvasRenderingContext2D, vp: Viewport, sel: Selection): void {
  const segments = selectionEdges(sel);
  if (segments.length === 0) return;

  const toScreen = (x: number, y: number): [number, number] => [
    Math.round(vp.panX + x * vp.zoom) + 0.5,
    Math.round(vp.panY + y * vp.zoom) + 0.5,
  ];

  const strokeAll = (color: string, offset: number) => {
    ctx.strokeStyle = color;
    ctx.lineDashOffset = offset;
    ctx.beginPath();
    for (const s of segments) {
      const [x0, y0] = toScreen(s.x0, s.y0);
      const [x1, y1] = toScreen(s.x1, s.y1);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  };

  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  strokeAll('#000000', 0);
  strokeAll('#ffffff', 4);

  ctx.restore();
}

export function drawCursorCell(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  docX: number,
  docY: number,
  brushSize: number,
): void {
  const size = Math.max(1, brushSize);
  const offset = Math.floor((size - 1) / 2);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(vp.panX + (docX - offset) * vp.zoom) - 0.5,
    Math.round(vp.panY + (docY - offset) * vp.zoom) - 0.5,
    size * vp.zoom + 1,
    size * vp.zoom + 1,
  );
  ctx.restore();
}
