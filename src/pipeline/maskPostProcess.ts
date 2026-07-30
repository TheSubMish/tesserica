/**
 * Stage [1]'s post-processing on whatever earlier step produced a mask — today
 * that is only the flood-fill fallback (`backgroundRemoval.ts`), later it will
 * also be a real ONNX segmentation model's matte (`docs/04-image-pipeline.md`
 * §8.3 step 5: "threshold, morphological close to fill holes, optional
 * feather").
 *
 * Mirrors `src-tauri/src/pipeline/mask_post_process.rs`.
 *
 * All three operate on the **alpha channel only**. Straight alpha
 * (`docs/02-architecture.md` §9) never needs a transparent pixel's RGB to
 * change, and none of these transforms are colour operations — Oklab (CLAUDE.md
 * invariant 5) is for colour *distance*, which is not what a mask edge is.
 *
 * `postProcessMask` runs the three in the fixed order §8.3 lists them in —
 * threshold, then close, then feather — and each is independently optional so a
 * mask that is already exactly what a caller wants (the flood-fill fallback's
 * own binary output, with no holes) is untouched by default.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import type { BackgroundRemovalSettings } from './settings.ts';

/**
 * Binarize the alpha channel at `cutoff` (§8.3 step 5): alpha below the cutoff
 * becomes fully transparent, alpha at or above becomes fully opaque.
 *
 * "Below" is exclusive, matching the existing `alphaThreshold` convention
 * (`quantize.ts`) — a cutoff of 0 still does something (any nonzero alpha snaps
 * up to fully opaque) rather than being a silent no-op.
 */
export function thresholdMask(image: PixelBuffer, cutoff: number): PixelBuffer {
  const out = Uint8ClampedArray.from(image.data);
  for (let i = 3; i < out.length; i += 4) {
    out[i] = out[i] < cutoff ? 0 : 255;
  }
  return bufferFrom(image.width, image.height, out);
}

/**
 * Dilate the alpha channel by one pixel, 4-connected — the same connectivity
 * `backgroundRemoval.ts`'s own flood and `cleanup.ts`'s despeckle use, for the
 * same reason: 8-connectivity would leak through a diagonal gap a person would
 * read as a separating edge.
 *
 * Grayscale (max over the neighbourhood), not a hard binary rule, so a soft
 * mask's untouched interior keeps its real alpha value rather than being forced
 * to 0/255 everywhere. A missing (out-of-bounds) neighbour simply does not
 * enter the max — equivalent to treating the world outside the canvas as
 * "nothing here to grow from", which is dilation's correct identity.
 */
function dilateAlpha(alpha: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(alpha);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let v = alpha[p];
      if (x > 0) v = Math.max(v, alpha[p - 1]);
      if (x + 1 < width) v = Math.max(v, alpha[p + 1]);
      if (y > 0) v = Math.max(v, alpha[p - width]);
      if (y + 1 < height) v = Math.max(v, alpha[p + width]);
      out[p] = v;
    }
  }
  return out;
}

/**
 * Erode the alpha channel by one pixel, the inverse of {@link dilateAlpha} (min
 * over the 4-connected neighbourhood).
 *
 * A missing neighbour is treated as fully opaque (255), not 0 — the standard
 * boundary condition for the *second* half of a closing pass: dilation already
 * used "nothing outside the canvas" as its identity, so erosion has to use the
 * opposite one, or closing would erode real content sitting at the image's own
 * edge on every pass.
 */
function erodeAlpha(alpha: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(alpha);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let v = alpha[p];
      v = Math.min(v, x > 0 ? alpha[p - 1] : 255);
      v = Math.min(v, x + 1 < width ? alpha[p + 1] : 255);
      v = Math.min(v, y > 0 ? alpha[p - width] : 255);
      v = Math.min(v, y + 1 < height ? alpha[p + width] : 255);
      out[p] = v;
    }
  }
  return out;
}

/**
 * Morphological close (§8.3 step 5): `radius` dilations followed by `radius`
 * erosions. Fills holes and gaps up to about `2 * radius` pixels across without
 * permanently growing the mask's outer boundary — the dilation and erosion
 * counts match exactly, so a region's true edge returns to where it started;
 * only a hole small enough to be swallowed by the dilation, and whose
 * surroundings stay opaque through the matching erosion, stays filled.
 *
 * `radius <= 0` is a no-op (0 is "off", matching `despeckle`'s own 0-off
 * convention).
 */
export function morphologicalClose(image: PixelBuffer, radius: number): PixelBuffer {
  const r = Math.trunc(radius);
  if (r <= 0) return image;
  const { width, height } = image;
  let alpha = extractAlpha(image);
  for (let i = 0; i < r; i++) alpha = dilateAlpha(alpha, width, height);
  for (let i = 0; i < r; i++) alpha = erodeAlpha(alpha, width, height);
  return withAlpha(image, alpha);
}

/**
 * One-dimensional box blur along image rows, edge-clamped by *shrinking* the
 * window rather than replicating a border value: a pixel `radius` from the edge
 * averages over however many real neighbours exist, not over a padded fiction.
 * That keeps a mask that runs up against the canvas edge from softening at the
 * canvas border itself — only a real internal edge feathers.
 *
 * Implemented with a running prefix sum so the cost is `O(width)` per row
 * regardless of `radius`, since this runs at source resolution (before
 * downscale) and a naive `O(width * radius)` scan would be the slow way to get
 * the same numbers.
 */
function boxBlurRows(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha.length);
  const prefix = new Float64Array(width + 1);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x] + alpha[base + x];
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      const count = hi - lo + 1;
      const sum = prefix[hi + 1] - prefix[lo];
      out[base + x] = Math.round(sum / count);
    }
  }
  return out;
}

/** Same as {@link boxBlurRows}, along columns instead. */
function boxBlurCols(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha.length);
  const prefix = new Float64Array(height + 1);
  for (let x = 0; x < width; x++) {
    prefix[0] = 0;
    for (let y = 0; y < height; y++) prefix[y + 1] = prefix[y] + alpha[y * width + x];
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      const count = hi - lo + 1;
      const sum = prefix[hi + 1] - prefix[lo];
      out[y * width + x] = Math.round(sum / count);
    }
  }
  return out;
}

/**
 * Feather the mask edge (§8.3 step 5, "optional feather"): a separable box
 * blur of the alpha channel over `radius` pixels, softening a hard aliased
 * cutout into a gradient instead. `radius <= 0` is a no-op.
 *
 * A box blur, not a Gaussian: `docs/04` names no specific kernel, and a box
 * blur is the smallest reasonable thing that produces a real falloff, is exact
 * integer arithmetic (no `libm` divergence risk between languages, unlike
 * Oklab), and is already the shape this codebase reaches for elsewhere
 * (alpha-weighted box downscale, §4's own box mode).
 */
export function featherMask(image: PixelBuffer, radius: number): PixelBuffer {
  const r = Math.trunc(radius);
  if (r <= 0) return image;
  const { width, height } = image;
  const alpha = extractAlpha(image);
  const horizontal = boxBlurRows(alpha, width, height, r);
  const both = boxBlurCols(horizontal, width, height, r);
  return withAlpha(image, both);
}

/**
 * Run threshold, then close, then feather — whichever are configured — in that
 * fixed order (§8.3 step 5). Each is skipped entirely when left at its "off"
 * value, so a `BackgroundRemovalSettings` with none of the three set is a
 * complete no-op, byte for byte.
 */
export function postProcessMask(
  image: PixelBuffer,
  settings: BackgroundRemovalSettings,
): PixelBuffer {
  let out = image;
  if (settings.threshold !== undefined) out = thresholdMask(out, settings.threshold);
  if (settings.close) out = morphologicalClose(out, settings.close);
  if (settings.feather) out = featherMask(out, settings.feather);
  return out;
}

function extractAlpha(image: PixelBuffer): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(image.width * image.height);
  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) alpha[p] = image.data[i];
  return alpha;
}

function withAlpha(image: PixelBuffer, alpha: Uint8ClampedArray): PixelBuffer {
  const out = Uint8ClampedArray.from(image.data);
  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) out[i] = alpha[p];
  return bufferFrom(image.width, image.height, out);
}
