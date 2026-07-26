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

import type { Sprite } from '../model/types';
import { getBuffer } from '../model/pixelBuffers';
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
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, sprite.width, sprite.height);

  for (const layer of sprite.layers) {
    if (!layer.visible || layer.opacity === 0) continue;

    const cel = sprite.cels.find((c) => c.layerId === layer.id && c.frameId === frameId);
    if (!cel) continue;

    const buf = getBuffer(cel.id);
    if (!buf) continue;

    const img = new ImageData(buf, cel.width, cel.height);

    if (layer.opacity >= 1) {
      ctx.putImageData(img, cel.x, cel.y);
    } else {
      // putImageData ignores globalAlpha, so route through a temp canvas.
      const tmp = document.createElement('canvas');
      tmp.width = cel.width;
      tmp.height = cel.height;
      tmp.getContext('2d')!.putImageData(img, 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(tmp, cel.x, cel.y);
      ctx.globalAlpha = 1;
    }
  }

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
