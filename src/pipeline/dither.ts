/**
 * Dithering (`docs/04-image-pipeline.md` §5) — part of stage [5].
 *
 * Mirrors `src-tauri/src/pipeline/dither.rs`.
 *
 * Three families, all shipped, because they are aesthetic choices rather than
 * quality tiers: error diffusion (Floyd–Steinberg, Atkinson), ordered/Bayer, and
 * none.
 *
 * **Everything here works in Oklab**, on an `f64` working buffer (§5.1, D12).
 * `colorSpace: 'srgb'` therefore affects only the *undithered* nearest-colour
 * lookup; §5.1 is unconditional about the dither buffer, and running error
 * diffusion in a space where equal distances do not look equally different is
 * the thing Oklab was adopted to stop.
 *
 * **No nearest-colour cache is used on the error-diffusion paths**, by design —
 * see §4.2 and the note on `quantizeErrorDiffusion` below.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import { type Oklab, distanceSq, srgb8ToOklab } from './oklab.ts';
import {
  TRANSPARENT_INDEX,
  type AlphaPolicy,
  type PreparedPalette,
  type QuantizeResult,
  nearestIndexOklab,
  resolveAlpha,
} from './quantize.ts';

/** One term of an error-diffusion kernel: an offset and its share of the error. */
export interface DiffusionTerm {
  readonly dx: number;
  readonly dy: number;
  readonly weight: number;
}

export interface DiffusionKernel {
  readonly terms: readonly DiffusionTerm[];
  /**
   * Alternate scan direction every row.
   *
   * On for Floyd–Steinberg, where it noticeably reduces the diagonal streaking
   * that plain left-to-right scanning produces (§5.1). Off for Atkinson, which
   * §5.2 describes as the classic Mac algorithm — that one is raster order, and
   * its look is part of why anyone picks it.
   */
  readonly serpentine: boolean;
}

/**
 * ```
 *         X    7/16
 *  3/16  5/16  1/16
 * ```
 */
export const FLOYD_STEINBERG: DiffusionKernel = {
  terms: [
    { dx: 1, dy: 0, weight: 7 / 16 },
    { dx: -1, dy: 1, weight: 3 / 16 },
    { dx: 0, dy: 1, weight: 5 / 16 },
    { dx: 1, dy: 1, weight: 1 / 16 },
  ],
  serpentine: true,
};

/**
 * ```
 *         X    1/8  1/8
 *  1/8   1/8   1/8
 *        1/8
 * ```
 *
 * Distributes only 6/8 of the error, discarding the rest — that is what makes it
 * higher contrast and "crunchier" than Floyd–Steinberg, and it is deliberate,
 * not a missing term.
 */
export const ATKINSON: DiffusionKernel = {
  terms: [
    { dx: 1, dy: 0, weight: 1 / 8 },
    { dx: 2, dy: 0, weight: 1 / 8 },
    { dx: -1, dy: 1, weight: 1 / 8 },
    { dx: 0, dy: 1, weight: 1 / 8 },
    { dx: 1, dy: 1, weight: 1 / 8 },
    { dx: 0, dy: 2, weight: 1 / 8 },
  ],
  serpentine: false,
};

/**
 * The `n`×`n` Bayer threshold matrix, built by the standard recurrence:
 *
 * ```
 *   M(1)  = [0]
 *   M(2n) = [ 4M(n)      4M(n)+2 ]
 *           [ 4M(n)+3    4M(n)+1 ]
 * ```
 *
 * Generated rather than table-driven so 2, 4 and 8 cannot disagree with each
 * other, and so both languages produce it from the same rule.
 */
export function bayerMatrix(n: number): Int32Array {
  if (n !== 2 && n !== 4 && n !== 8) {
    throw new Error(`Bayer matrix size must be 2, 4 or 8, got ${n}`);
  }
  let size = 1;
  let m = new Int32Array([0]);
  while (size < n) {
    const next = new Int32Array(size * size * 4);
    const nextSize = size * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y * size + x] * 4;
        next[y * nextSize + x] = v;
        next[y * nextSize + (x + size)] = v + 2;
        next[(y + size) * nextSize + x] = v + 3;
        next[(y + size) * nextSize + (x + size)] = v + 1;
      }
    }
    m = next;
    size = nextSize;
  }
  return m;
}

/**
 * How far apart the palette's colours are, in Oklab — the `spread` of §5.3.
 *
 * The mean distance from each entry to its nearest other entry. A fixed value
 * looks wrong on both a 4-colour and a 64-colour palette: too little spread and
 * ordered dithering does nothing, too much and it shreds the image. Zero for a
 * one-colour palette, where dithering has nothing to choose between.
 *
 * `sqrt` is IEEE-754 correctly rounded, unlike `cbrt` and `powf`, so this
 * particular number is bit-identical in both languages.
 */
export function paletteSpread(palette: PreparedPalette): number {
  if (palette.lab.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < palette.lab.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < palette.lab.length; j++) {
      if (i === j) continue;
      const d = distanceSq(palette.lab[i], palette.lab[j]);
      if (d < nearest) nearest = d;
    }
    total += Math.sqrt(nearest);
  }
  return total / palette.lab.length;
}

/**
 * Ordered (Bayer) dithering.
 *
 * The threshold offset is applied to **`L` only**, not to all three Oklab
 * channels. §5.3 writes `adjusted = pixel + threshold * strength * spread`; in
 * the RGB implementations that formula comes from, adding the same amount to
 * R, G and B is a move along the grey axis — that is, a *lightness* shift. `L`
 * alone is the faithful translation of that into Oklab. Adding the same scalar
 * to `a` and `b` as well would drag every pixel in one fixed hue direction,
 * which is a different effect and not the one anyone means by ordered dither.
 *
 * Fully parallelizable and resolution-independent in character, which makes this
 * the safest mode for preview/export parity.
 */
export function quantizeOrdered(
  src: PixelBuffer,
  palette: PreparedPalette,
  policy: AlphaPolicy,
  n: number,
  strength: number,
): QuantizeResult {
  const matrix = bayerMatrix(n);
  const spread = paletteSpread(palette);
  const scale = 1 / (n * n);

  const out = new Uint8ClampedArray(src.data.length);
  const indices = new Uint16Array(src.width * src.height);

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const p = y * src.width + x;
      const i = p * 4;

      const a = resolveAlpha(src.data[i + 3], policy);
      if (a === 0) {
        indices[p] = TRANSPARENT_INDEX;
        continue;
      }

      const threshold = (matrix[(y % n) * n + (x % n)] + 0.5) * scale - 0.5;
      const c = srgb8ToOklab(src.data[i], src.data[i + 1], src.data[i + 2]);
      const shifted: Oklab = { l: c.l + threshold * strength * spread, a: c.a, b: c.b };

      const idx = nearestIndexOklab(palette, shifted);
      const entry = palette.colors[idx];
      indices[p] = idx;
      out[i] = entry[0];
      out[i + 1] = entry[1];
      out[i + 2] = entry[2];
      out[i + 3] = a;
    }
  }

  return { image: bufferFrom(src.width, src.height, out), indices };
}

/**
 * Error-diffusion dithering.
 *
 * > ⚠️ **The nearest-colour cache is invalid here** (§4.2). It is keyed on
 * > quantized RGB, and diffused error pushes colours to arbitrary values — the
 * > cache would round away the very error being propagated. This path computes
 * > every lookup directly, and must keep doing so.
 *
 * Inherently sequential: each pixel depends on its predecessors. This is the one
 * stage `rayon` cannot trivially parallelize, and the reason preview and export
 * cannot match exactly at *different* resolutions (`docs/02` §3.3). At equal
 * resolution it is fully deterministic, which is why the golden suite can still
 * demand an exact match.
 *
 * Transparent pixels neither produce error nor stop it: they are skipped, and
 * error diffused onto them simply goes nowhere, because they are never
 * quantized. Diffusing *their* colour would smear a dropped pixel's RGB into the
 * visible image, which is the alpha-fringe bug in a different disguise.
 */
export function quantizeErrorDiffusion(
  src: PixelBuffer,
  palette: PreparedPalette,
  policy: AlphaPolicy,
  kernel: DiffusionKernel,
  strength: number,
): QuantizeResult {
  const { width, height } = src;
  const buf = new Float64Array(width * height * 3);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const c = srgb8ToOklab(src.data[i], src.data[i + 1], src.data[i + 2]);
    buf[p * 3] = c.l;
    buf[p * 3 + 1] = c.a;
    buf[p * 3 + 2] = c.b;
  }

  const out = new Uint8ClampedArray(src.data.length);
  const indices = new Uint16Array(width * height);

  for (let y = 0; y < height; y++) {
    const rightward = !kernel.serpentine || y % 2 === 0;
    for (let step = 0; step < width; step++) {
      const x = rightward ? step : width - 1 - step;
      const p = y * width + x;
      const i = p * 4;

      const a = resolveAlpha(src.data[i + 3], policy);
      if (a === 0) {
        indices[p] = TRANSPARENT_INDEX;
        continue;
      }

      const old: Oklab = { l: buf[p * 3], a: buf[p * 3 + 1], b: buf[p * 3 + 2] };
      const idx = nearestIndexOklab(palette, old);
      const chosen = palette.lab[idx];
      const entry = palette.colors[idx];

      indices[p] = idx;
      out[i] = entry[0];
      out[i + 1] = entry[1];
      out[i + 2] = entry[2];
      out[i + 3] = a;

      const el = (old.l - chosen.l) * strength;
      const ea = (old.a - chosen.a) * strength;
      const eb = (old.b - chosen.b) * strength;

      for (const term of kernel.terms) {
        // Mirror the horizontal offsets when scanning right to left, or the
        // kernel would push error into pixels that are already done.
        const nx = x + (rightward ? term.dx : -term.dx);
        const ny = y + term.dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const q = (ny * width + nx) * 3;
        buf[q] += el * term.weight;
        buf[q + 1] += ea * term.weight;
        buf[q + 2] += eb * term.weight;
      }
    }
  }

  return { image: bufferFrom(width, height, out), indices };
}
