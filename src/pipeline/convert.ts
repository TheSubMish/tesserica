/**
 * The pipeline driver — stage order per `docs/04-image-pipeline.md` §2.
 *
 * Mirrors `src-tauri/src/pipeline/convert.rs`.
 *
 * ```
 *   [1] background removal   Rust only, Phase 5 — not yet in the chain
 *   [2] crop / fit-to-subject
 *   [3] colour adjustments   BEFORE quantization, deliberately (§2.1)
 *   [4] downscale to grid
 *   [5] quantize + dither
 *   [6] cleanup
 * ```
 *
 * **The order is fixed and identical in both implementations.** It is not a
 * default that a caller may vary: adjusting after quantization pushes colours
 * off the palette and forces a second mapping, compounding error.
 */

import { adjustParamsFrom, applyAdjustments } from './adjust.ts';
import { autoPalette } from './autopalette.ts';
import type { PixelBuffer } from './buffer.ts';
import { despeckle, outline } from './cleanup.ts';
import { crop, fitToSubject } from './crop.ts';
import { ATKINSON, FLOYD_STEINBERG, quantizeErrorDiffusion, quantizeOrdered } from './dither.ts';
import { downscale } from './downscale.ts';
import {
  TRANSPARENT_INDEX,
  alphaPolicyFrom,
  preparePalette,
  NearestCache,
  quantizeNone,
  renderIndices,
  type AlphaPolicy,
  type PreparedPalette,
  type QuantizeResult,
} from './quantize.ts';
import type { ConvertSettings, PaletteSpec } from './settings.ts';

export interface ConvertResult {
  readonly image: PixelBuffer;
  /** One entry per output pixel; `TRANSPARENT_INDEX` where transparent. */
  readonly indices: Uint16Array;
  /** The palette actually used — the resolved one when `palette` was `auto`. */
  readonly palette: PreparedPalette;
}

/**
 * Padding added around the subject's bounding box by `fitToSubject`.
 *
 * `docs/04` §8.5 says "add padding" without naming an amount, and §2.2 has no
 * field for it. Zero is the smallest thing that is not wrong; when a control for
 * it appears, it belongs in `ConvertSettings`.
 */
export const FIT_TO_SUBJECT_PADDING = 0;

/**
 * Resolve the settings' palette against the image being converted.
 *
 * `auto` is derived from the **downscaled** image, not the source: those are the
 * colours that will actually be quantized, and choosing against the source would
 * spend palette entries on detail the downscale is about to average away.
 */
export function resolvePalette(
  spec: PaletteSpec,
  image: PixelBuffer,
  alphaThreshold: number,
): PreparedPalette {
  switch (spec.kind) {
    case 'fixed':
      return preparePalette(spec.colors);
    case 'auto':
      return preparePalette(autoPalette(image, spec.maxColors, alphaThreshold));
  }
}

/**
 * Stage [5]'s dispatcher.
 *
 * `colorSpace` reaches only the undithered path: §5.1 says the error-diffusion
 * working buffer is in Oklab, unconditionally, and ordered dithering shares that
 * buffer's units so that `spread` means one thing.
 */
export function quantizeWithDither(
  image: PixelBuffer,
  palette: PreparedPalette,
  policy: AlphaPolicy,
  settings: ConvertSettings,
): QuantizeResult {
  const strength = settings.ditherStrength;
  switch (settings.dither) {
    case 'none':
      return quantizeNone(image, palette, settings.colorSpace, policy, new NearestCache(1));
    // The two error-diffusion modes deliberately get no cache (§4.2), and could
    // not use one: their lookups are on arbitrary Oklab floats, not on a colour
    // with a 24-bit key.
    case 'floyd-steinberg':
      return quantizeErrorDiffusion(image, palette, policy, FLOYD_STEINBERG, strength);
    case 'atkinson':
      return quantizeErrorDiffusion(image, palette, policy, ATKINSON, strength);
    case 'bayer2':
      return quantizeOrdered(image, palette, policy, 2, strength, new NearestCache(4));
    case 'bayer4':
      return quantizeOrdered(image, palette, policy, 4, strength, new NearestCache(16));
    case 'bayer8':
      return quantizeOrdered(image, palette, policy, 8, strength, new NearestCache(64));
  }
}

export function convert(source: PixelBuffer, settings: ConvertSettings): ConvertResult {
  // [2] framing
  let image = source;
  if (settings.crop) image = crop(image, settings.crop);
  if (settings.fitToSubject) {
    image = fitToSubject(image, settings.alphaThreshold, FIT_TO_SUBJECT_PADDING);
  }

  // [3] adjustments — before quantization (§2.1)
  image = applyAdjustments(image, adjustParamsFrom(settings));

  // [4] downscale
  image = downscale(image, settings.targetWidth, settings.targetHeight, settings.downscaleMode);

  // [5] quantize + dither
  const palette = resolvePalette(settings.palette, image, settings.alphaThreshold);
  const policy = alphaPolicyFrom(settings);
  const quantized = quantizeWithDither(image, palette, policy, settings);

  // [6] cleanup
  let indices = quantized.indices;
  let alpha = extractAlpha(quantized.image);

  if (settings.despeckle > 0) {
    indices = despeckle(image.width, image.height, indices, settings.despeckle);
    alpha = alphaForIndices(indices, alpha, policy.preserveAlpha);
  }

  if (settings.outline) {
    const outlined = outline(image.width, image.height, indices, alpha, palette, settings.outline);
    indices = outlined.indices;
    alpha = outlined.alpha;
  }

  return {
    image: renderIndices(image.width, image.height, indices, palette, alpha),
    indices,
    palette,
  };
}

function extractAlpha(image: PixelBuffer): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(image.width * image.height);
  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) alpha[p] = image.data[i];
  return alpha;
}

/**
 * Reconcile alpha with an index map that despeckle just changed.
 *
 * A pixel that was transparent and became a colour needs an alpha, and one that
 * went the other way needs zero. With `preserveAlpha` off there is one answer
 * (255); with it on there is no source value to restore for a pixel that was
 * transparent, so 255 is the only honest choice there too.
 */
function alphaForIndices(
  indices: Uint16Array,
  alpha: Uint8ClampedArray,
  _preserveAlpha: boolean,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(alpha);
  for (let p = 0; p < indices.length; p++) {
    if (indices[p] === TRANSPARENT_INDEX) out[p] = 0;
    else if (out[p] === 0) out[p] = 255;
  }
  return out;
}
