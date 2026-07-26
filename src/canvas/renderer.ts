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

import type { Cel, CelId, Layer, Sprite } from '../model/types';
import { celRevision, getBuffer } from '../model/pixelBuffers';
import type { Viewport } from './coords';

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
}

/**
 * What the composite depends on. Anything not in here must not be able to
 * change the output, or the cache will serve a stale frame.
 */
function signatureOf(sprite: Sprite, frameId: string): string {
  const parts: string[] = [`${sprite.width}x${sprite.height}@${frameId}`];
  for (const layer of sprite.layers) {
    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    parts.push(
      `${layer.id}:${layer.visible ? 1 : 0}:${layer.opacity}:${layer.blendMode}:` +
        `${cel ? `${cel.id}@${cel.x},${cel.y}#${celRevision(cel.id)}` : '-'}`,
    );
  }
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

  for (const layer of sprite.layers) {
    if (!isDrawable(layer)) continue;

    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    if (!cel) continue;

    const source = celCanvas(cel);
    if (!source) continue;

    // `putImageData` ignores `globalAlpha`, so layer opacity has to come from
    // `drawImage` off the cel's own canvas. Straight alpha is preserved:
    // Canvas2D's source-over on unassociated ImageData is what we want, and no
    // premultiplication is introduced anywhere on this path.
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(source, cel.x, cel.y);
    ctx.globalAlpha = 1;
  }

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
