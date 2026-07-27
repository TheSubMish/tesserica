/**
 * Stage [2] — crop / fit-to-subject (`docs/04-image-pipeline.md` §2, §8.5).
 *
 * Mirrors `src-tauri/src/pipeline/crop.rs`.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import type { CropRect } from './settings.ts';

/**
 * Crop to `rect`, clamped to the source.
 *
 * A rect that misses the image entirely is an error rather than a 0×0 buffer —
 * every later stage assumes a non-empty image, and failing here names the
 * actual mistake.
 */
export function crop(src: PixelBuffer, rect: CropRect): PixelBuffer {
  const x0 = clamp(Math.trunc(rect.x), 0, src.width);
  const y0 = clamp(Math.trunc(rect.y), 0, src.height);
  const x1 = clamp(Math.trunc(rect.x + rect.w), 0, src.width);
  const y1 = clamp(Math.trunc(rect.y + rect.h), 0, src.height);

  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) {
    throw new Error(
      `crop rect ${rect.x},${rect.y} ${rect.w}x${rect.h} does not overlap the ` +
        `${src.width}x${src.height} source`,
    );
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * src.width + x0) * 4;
    out.set(src.data.subarray(from, from + w * 4), y * w * 4);
  }
  return bufferFrom(w, h, out);
}

/**
 * Bounding box of everything with alpha above `threshold`, or `undefined` when
 * nothing is.
 */
export function opaqueBounds(src: PixelBuffer, threshold: number): CropRect | undefined {
  let minX = src.width;
  let minY = src.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return undefined;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Crop to the subject's bounding box (`docs/04` §8.5).
 *
 * `padding` is in source pixels and is clamped to the image. Returns the source
 * unchanged when the whole image is subject, or when none of it is — a fully
 * opaque photo and a fully transparent buffer both mean "there is nothing to
 * fit to", and silently returning a 1×1 image would be worse than doing
 * nothing.
 */
export function fitToSubject(
  src: PixelBuffer,
  alphaThreshold: number,
  padding: number,
): PixelBuffer {
  const bounds = opaqueBounds(src, alphaThreshold);
  if (!bounds) return src;

  const rect: CropRect = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
  };
  return crop(src, rect);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
