/**
 * Stage [4] — downscale to the target grid (`docs/04-image-pipeline.md` §3).
 *
 * Mirrors `src-tauri/src/pipeline/downscale.rs`.
 *
 * This step decides whether the output looks like pixel art or like a broken
 * thumbnail, and it is where the most common bug in naive converters lives:
 * averaging a transparent pixel's RGB bleeds a dark fringe into every edge.
 * `box` therefore weights colour by alpha and averages alpha separately.
 *
 * Cell boundaries are computed with **integer** arithmetic, not by accumulating
 * a float step, so the two implementations partition the source identically by
 * construction rather than by luck.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import { linearToSrgb, srgb8ToLinear } from './oklab.ts';
import type { DownscaleMode } from './settings.ts';

/** Inclusive-exclusive source range covering output column/row `i`. */
export function cellRange(i: number, dst: number, src: number): [start: number, end: number] {
  const start = Math.min(Math.floor((i * src) / dst), src - 1);
  const end = Math.min(Math.max(Math.floor(((i + 1) * src) / dst), start + 1), src);
  return [start, end];
}

/** Source index of the sample point at the centre of output column/row `i`. */
export function cellCentre(i: number, dst: number, src: number): number {
  return Math.min(Math.floor(((2 * i + 1) * src) / (2 * dst)), src - 1);
}

export function downscale(
  src: PixelBuffer,
  targetWidth: number,
  targetHeight: number,
  mode: DownscaleMode,
): PixelBuffer {
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)) {
    throw new Error(`target size must be integral, got ${targetWidth}x${targetHeight}`);
  }
  if (targetWidth < 1 || targetHeight < 1) {
    throw new Error(`target size must be at least 1x1, got ${targetWidth}x${targetHeight}`);
  }
  if (targetWidth === src.width && targetHeight === src.height) return src;

  switch (mode) {
    case 'box':
      return downscaleBox(src, targetWidth, targetHeight);
    case 'nearest':
      return downscaleNearest(src, targetWidth, targetHeight);
    case 'dominant':
      return downscaleDominant(src, targetWidth, targetHeight);
  }
}

/**
 * Alpha-weighted box average, computed in **linear light**.
 *
 * Two things are load-bearing:
 *
 * - **Alpha weighting.** RGB is averaged weighted by alpha; alpha is averaged on
 *   its own. Without this, a transparent pixel's RGB (usually black) drags every
 *   edge dark — the classic converter fringe (`docs/04` §4.4).
 * - **Linear light.** Averaging gamma-encoded values darkens texture and mid-
 *   tones. Averaging in linear light and re-encoding once is what "average the
 *   pixels in the cell" has to mean to be photometrically correct.
 */
function downscaleBox(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    const [y0, y1] = cellRange(y, dstH, src.height);
    for (let x = 0; x < dstW; x++) {
      const [x0, x1] = cellRange(x, dstW, src.width);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * src.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          const a = src.data[i + 3];
          sumA += a;
          count++;
          if (a !== 0) {
            sumR += srgb8ToLinear(src.data[i]) * a;
            sumG += srgb8ToLinear(src.data[i + 1]) * a;
            sumB += srgb8ToLinear(src.data[i + 2]) * a;
          }
        }
      }

      const o = (y * dstW + x) * 4;
      if (sumA > 0) {
        out[o] = to8(linearToSrgb(sumR / sumA));
        out[o + 1] = to8(linearToSrgb(sumG / sumA));
        out[o + 2] = to8(linearToSrgb(sumB / sumA));
      }
      out[o + 3] = Math.round(sumA / count);
    }
  }

  return bufferFrom(dstW, dstH, out);
}

/** Sample the centre of each cell. Correct for sources that are already pixel art. */
function downscaleNearest(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = cellCentre(y, dstH, src.height);
    for (let x = 0; x < dstW; x++) {
      const sx = cellCentre(x, dstW, src.width);
      const i = (sy * src.width + sx) * 4;
      const o = (y * dstW + x) * 4;
      out[o] = src.data[i];
      out[o + 1] = src.data[i + 1];
      out[o + 2] = src.data[i + 2];
      out[o + 3] = src.data[i + 3];
    }
  }
  return bufferFrom(dstW, dstH, out);
}

/**
 * Most frequent colour in the cell, after a coarse pre-quantize.
 *
 * The pre-quantize key is the top 5 bits per channel — the same key the
 * nearest-colour cache uses (`docs/04` §4.2), so "coarse" means one thing in
 * this codebase rather than two.
 *
 * Concretely, since §3.1 leaves it open:
 * - only pixels with `alpha != 0` vote;
 * - the winning bucket is the one with the most votes, ties going to the lowest
 *   key, so the result never depends on iteration order;
 * - the output colour is the **first pixel in scanline order** belonging to that
 *   bucket — a real colour from the source, not an average that would reintroduce
 *   exactly the invented colours this mode exists to avoid;
 * - alpha is the plain mean over the whole cell, as in `box`, so edges keep their
 *   softness.
 */
function downscaleDominant(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const counts = new Map<number, number>();

  for (let y = 0; y < dstH; y++) {
    const [y0, y1] = cellRange(y, dstH, src.height);
    for (let x = 0; x < dstW; x++) {
      const [x0, x1] = cellRange(x, dstW, src.width);

      counts.clear();
      let sumA = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * src.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          const a = src.data[i + 3];
          sumA += a;
          count++;
          if (a !== 0) {
            const key = coarseKey(src.data[i], src.data[i + 1], src.data[i + 2]);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }

      const o = (y * dstW + x) * 4;
      out[o + 3] = Math.round(sumA / count);

      if (counts.size > 0) {
        let bestKey = -1;
        let bestCount = 0;
        for (const [key, n] of counts) {
          if (n > bestCount || (n === bestCount && key < bestKey)) {
            bestKey = key;
            bestCount = n;
          }
        }
        // First pixel of the winning bucket, scanline order.
        found: for (let sy = y0; sy < y1; sy++) {
          let i = (sy * src.width + x0) * 4;
          for (let sx = x0; sx < x1; sx++, i += 4) {
            if (
              src.data[i + 3] !== 0 &&
              coarseKey(src.data[i], src.data[i + 1], src.data[i + 2]) === bestKey
            ) {
              out[o] = src.data[i];
              out[o + 1] = src.data[i + 1];
              out[o + 2] = src.data[i + 2];
              break found;
            }
          }
        }
      }
    }
  }

  return bufferFrom(dstW, dstH, out);
}

/** Top 5 bits per channel — the same key as the nearest-colour cache (§4.2). */
export function coarseKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function to8(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
