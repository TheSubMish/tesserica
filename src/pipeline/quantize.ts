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
  cache?: NearestCache,
): QuantizeResult {
  const out = new Uint8ClampedArray(src.data.length);
  const indices = new Uint16Array(src.width * src.height);

  for (let p = 0, i = 0; i < src.data.length; p++, i += 4) {
    const a = resolveAlpha(src.data[i + 3], policy);
    if (a === 0) {
      indices[p] = TRANSPARENT_INDEX;
      continue;
    }
    const r = src.data[i];
    const g = src.data[i + 1];
    const b = src.data[i + 2];
    const idx = cache
      ? cache.lookup(r, g, b, 0, () => nearestIndex(palette, r, g, b, space))
      : nearestIndex(palette, r, g, b, space);
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

/**
 * Direct-mapped memo for nearest-colour lookups (`docs/04` §4.2).
 *
 * §4.2 sketches a table keyed on the top 5 bits per channel. Taken literally
 * that is **lossy** — two colours 7 apart in red would share an answer — which
 * is a quality regression bought with speed, and quietly changes output.
 *
 * So the key is the same (5 bits per channel, 32,768 slots, same locality) but
 * each slot also stores the **full 24-bit colour it was filled from**. A hit
 * requires the tag to match; a mismatch recomputes and replaces. The cache is
 * then a pure memoization: it cannot change a single output pixel, which is
 * asserted directly in the tests and, more usefully, by the fact that the entire
 * golden corpus produces byte-identical output with and without it.
 *
 * `lanes` exists for ordered dithering, where the same source colour resolves
 * differently depending on its position in the Bayer cell. One lane per cell
 * position keeps the memo exact there too.
 *
 * > ⚠️ **Error diffusion must not use this**, and structurally cannot: the
 * > lookup takes 8-bit sRGB, while diffused values are arbitrary Oklab floats
 * > with no 24-bit key to tag on. That is §4.2's carve-out enforced by the
 * > types rather than by a comment.
 */
export class NearestCache {
  static readonly SLOTS_PER_LANE = 32768;

  private readonly tags: Int32Array;
  private readonly values: Uint16Array;

  constructor(readonly lanes: number = 1) {
    if (!Number.isInteger(lanes) || lanes < 1) {
      throw new Error(`lanes must be a positive integer, got ${lanes}`);
    }
    const size = lanes * NearestCache.SLOTS_PER_LANE;
    // -1 is "empty"; a real tag is a 24-bit colour, always >= 0.
    this.tags = new Int32Array(size).fill(-1);
    this.values = new Uint16Array(size);
  }

  /** Top 5 bits per channel — the key from §4.2, shared with `coarseKey`. */
  static slot(r: number, g: number, b: number): number {
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  }

  static tag(r: number, g: number, b: number): number {
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Memoize `compute` against the source colour and lane.
   *
   * The caller supplies the computation rather than the cache deriving it,
   * because the two callers do different things: undithered quantization asks
   * for the nearest entry to the colour, ordered dithering asks for the nearest
   * entry to the colour *perturbed by its Bayer cell*. Both are pure functions
   * of `(r, g, b, lane)`, which is exactly what makes memoizing them exact.
   */
  lookup(r: number, g: number, b: number, lane: number, compute: () => number): number {
    const at = lane * NearestCache.SLOTS_PER_LANE + NearestCache.slot(r, g, b);
    const tag = NearestCache.tag(r, g, b);
    if (this.tags[at] === tag) return this.values[at];

    const idx = compute();
    this.tags[at] = tag;
    this.values[at] = idx;
    return idx;
  }
}
