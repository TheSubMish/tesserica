/**
 * Stage [5] — quantize to the palette (`docs/04-image-pipeline.md` §4).
 *
 * Mirrors `src-tauri/src/pipeline/quantize.rs`.
 *
 * Dithering is a separate module that plugs in here; this file owns the palette
 * preparation, the nearest-colour search, and the alpha policy that every dither
 * mode shares.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import { NEAREST_EPSILON, type Oklab, distanceSq, srgb8ToOklab } from './oklab.ts';
import type { ColorSpace, ConvertSettings, Rgba } from './settings.ts';

/**
 * The index map's stand-in for "this pixel is transparent and was never
 * quantized" (`docs/04` §4.4).
 *
 * `u16::MAX`, which also caps a palette at 65,535 entries — four orders of
 * magnitude beyond anything a pixel-art palette contains.
 */
export const TRANSPARENT_INDEX = 0xffff;

export interface QuantizeResult {
  readonly image: PixelBuffer;
  /** One entry per pixel, row-major; `TRANSPARENT_INDEX` where transparent. */
  readonly indices: Uint16Array;
}

/** A palette with its Oklab conversion done once, up front (§4.2). */
export interface PreparedPalette {
  readonly colors: readonly Rgba[];
  readonly lab: readonly Oklab[];
}

export function preparePalette(colors: readonly Rgba[]): PreparedPalette {
  if (colors.length === 0) throw new Error('palette is empty');
  if (colors.length > TRANSPARENT_INDEX) {
    throw new Error(`palette has ${colors.length} entries, maximum is ${TRANSPARENT_INDEX}`);
  }
  return { colors, lab: colors.map((c) => srgb8ToOklab(c[0], c[1], c[2])) };
}

/**
 * Nearest palette entry to an Oklab colour.
 *
 * The `- NEAREST_EPSILON` is D12's tie-break, not a micro-optimization: it makes
 * near-ties resolve to the **lowest palette index** in both languages. Exact
 * ties are real — a mid-grey exactly between two entries of a grayscale ramp
 * produces one — and without this the two implementations could legitimately
 * disagree on such a pixel while both being correct.
 */
export function nearestIndexOklab(palette: PreparedPalette, c: Oklab): number {
  let best = 0;
  let bestD = distanceSq(c, palette.lab[0]);
  for (let i = 1; i < palette.lab.length; i++) {
    const d = distanceSq(c, palette.lab[i]);
    if (d < bestD - NEAREST_EPSILON) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Nearest palette entry in sRGB.
 *
 * Perceptually wrong — equal RGB distances do not look equally different and
 * dark colours collapse together — and exposed only as an escape hatch for
 * matching another tool's output (§4.1). Same tie-break, for the same reason.
 */
export function nearestIndexSrgb(
  palette: PreparedPalette,
  r: number,
  g: number,
  b: number,
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.colors.length; i++) {
    const p = palette.colors[i];
    const dr = r - p[0];
    const dg = g - p[1];
    const db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD - NEAREST_EPSILON) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function nearestIndex(
  palette: PreparedPalette,
  r: number,
  g: number,
  b: number,
  space: ColorSpace,
): number {
  return space === 'oklab'
    ? nearestIndexOklab(palette, srgb8ToOklab(r, g, b))
    : nearestIndexSrgb(palette, r, g, b);
}

export interface AlphaPolicy {
  /** 0..255. Below this a pixel is fully transparent and is not quantized. */
  readonly alphaThreshold: number;
  /** Keep the source alpha above the threshold instead of snapping to opaque. */
  readonly preserveAlpha: boolean;
}

export function alphaPolicyFrom(settings: ConvertSettings): AlphaPolicy {
  return { alphaThreshold: settings.alphaThreshold, preserveAlpha: settings.preserveAlpha };
}

/**
 * Resolve a pixel's output alpha, or `0` when it is to be dropped entirely.
 *
 * Alpha is never quantized against the palette, and a palette entry's own alpha
 * is ignored — the palette is a list of *colours* (§4.4, D9).
 */
export function resolveAlpha(a: number, policy: AlphaPolicy): number {
  if (a < policy.alphaThreshold) return 0;
  return policy.preserveAlpha ? a : 255;
}

/**
 * Quantize with no dithering.
 *
 * Split out from the dispatcher so the dither modes can share the alpha policy
 * and the index-map contract without re-deriving them.
 */
export function quantizeNone(
  src: PixelBuffer,
  palette: PreparedPalette,
  space: ColorSpace,
  policy: AlphaPolicy,
): QuantizeResult {
  const out = new Uint8ClampedArray(src.data.length);
  const indices = new Uint16Array(src.width * src.height);

  for (let p = 0, i = 0; i < src.data.length; p++, i += 4) {
    const a = resolveAlpha(src.data[i + 3], policy);
    if (a === 0) {
      indices[p] = TRANSPARENT_INDEX;
      continue;
    }
    const idx = nearestIndex(palette, src.data[i], src.data[i + 1], src.data[i + 2], space);
    const c = palette.colors[idx];
    indices[p] = idx;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = a;
  }

  return { image: bufferFrom(src.width, src.height, out), indices };
}

/** Paint an index map back into RGBA using the palette and a source's alpha. */
export function renderIndices(
  width: number,
  height: number,
  indices: Uint16Array,
  palette: PreparedPalette,
  alpha: Uint8ClampedArray,
): PixelBuffer {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    const idx = indices[p];
    if (idx === TRANSPARENT_INDEX) continue;
    const c = palette.colors[idx];
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = alpha[p];
  }
  return bufferFrom(width, height, out);
}
