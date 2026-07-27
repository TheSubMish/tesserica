/**
 * Oklab — the perceptual colour space every colour decision in the pipeline is
 * made in (`docs/04-image-pipeline.md` §4.1).
 *
 * Mirrors `src-tauri/src/pipeline/oklab.rs` function for function. When you
 * touch one, touch the other in the same change.
 *
 * The transform constants below are Bjorn Ottosson's published matrices. They
 * are *duplicated on purpose* from `shared/oklab.constants.json` rather than
 * imported: this is a hot path and the JSON would cost a property chase per
 * pixel. `oklab.test.ts` asserts every literal here against that file, and
 * `oklab.rs` does the same on its side, so the duplication cannot drift (D10).
 *
 * Precision is `f64` on both sides (D12). See the decision log for the
 * measurement — the short version is that `f32` in Rust drifts up to 3.6e-7
 * from `f64`, which is enough to flip a nearest-colour `argmin` near a tie and
 * change an output pixel, whereas the 6.7e-16 residual between Rust `f64` and
 * JS `f64` cannot.
 */

export const SRGB_TO_LINEAR = {
  threshold: 0.04045,
  divisor: 12.92,
  offset: 0.055,
  scale: 1.055,
  exponent: 2.4,
} as const;

export const LINEAR_TO_SRGB = {
  threshold: 0.0031308,
  scale: 12.92,
  mul: 1.055,
  offset: 0.055,
  exponent: 2.4,
} as const;

export const LINEAR_TO_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
] as const;

export const LMS_TO_OKLAB = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
] as const;

export const OKLAB_TO_LMS = [
  [1.0, 0.3963377774, 0.2158037573],
  [1.0, -0.1055613458, -0.0638541728],
  [1.0, -0.0894841775, -1.291485548],
] as const;

export const LMS_TO_LINEAR = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
] as const;

// Flattened for the hot path — derived from the exported matrices above, so
// they cannot fall out of step with them.
const [[f00, f01, f02], [f10, f11, f12], [f20, f21, f22]] = LINEAR_TO_LMS;
const [[g00, g01, g02], [g10, g11, g12], [g20, g21, g22]] = LMS_TO_OKLAB;
const [[h00, h01, h02], [h10, h11, h12], [h20, h21, h22]] = OKLAB_TO_LMS;
const [[k00, k01, k02], [k10, k11, k12], [k20, k21, k22]] = LMS_TO_LINEAR;

/**
 * A colour in Oklab. `l` is perceptual lightness in roughly 0..1; `a` and `b`
 * are the opponent axes, roughly -0.4..0.4 for in-gamut sRGB.
 *
 * Alpha is deliberately absent. Alpha is never quantized against the palette
 * and never travels through the colour-distance code (`docs/04` §4.4).
 */
export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** sRGB electro-optical transfer function. `c` in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= SRGB_TO_LINEAR.threshold
    ? c / SRGB_TO_LINEAR.divisor
    : Math.pow((c + SRGB_TO_LINEAR.offset) / SRGB_TO_LINEAR.scale, SRGB_TO_LINEAR.exponent);
}

/** Inverse of {@link srgbToLinear}. `c` in 0..1. */
export function linearToSrgb(c: number): number {
  return c <= LINEAR_TO_SRGB.threshold
    ? c * LINEAR_TO_SRGB.scale
    : LINEAR_TO_SRGB.mul * Math.pow(c, 1 / LINEAR_TO_SRGB.exponent) - LINEAR_TO_SRGB.offset;
}

/** sRGB (0..1 per channel) → Oklab. */
export function srgbToOklab(r: number, g: number, b: number): Oklab {
  return linearSrgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

/** Linear sRGB (0..1 per channel) → Oklab. */
export function linearSrgbToOklab(r: number, g: number, b: number): Oklab {
  const l = f00 * r + f01 * g + f02 * b;
  const m = f10 * r + f11 * g + f12 * b;
  const s = f20 * r + f21 * g + f22 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    l: g00 * l_ + g01 * m_ + g02 * s_,
    a: g10 * l_ + g11 * m_ + g12 * s_,
    b: g20 * l_ + g21 * m_ + g22 * s_,
  };
}

/** Oklab → linear sRGB. May return out-of-gamut values; see {@link oklabToSrgb}. */
export function oklabToLinearSrgb(c: Oklab): [r: number, g: number, b: number] {
  const l_ = h00 * c.l + h01 * c.a + h02 * c.b;
  const m_ = h10 * c.l + h11 * c.a + h12 * c.b;
  const s_ = h20 * c.l + h21 * c.a + h22 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [k00 * l + k01 * m + k02 * s, k10 * l + k11 * m + k12 * s, k20 * l + k21 * m + k22 * s];
}

/**
 * Oklab → sRGB (0..1 per channel).
 *
 * Out-of-gamut results are clamped in **linear** light, before the transfer
 * function, and both implementations must clamp at the same point — clamping
 * after encoding gives different values for the same input.
 */
export function oklabToSrgb(c: Oklab): [r: number, g: number, b: number] {
  const [lr, lg, lb] = oklabToLinearSrgb(c);
  return [linearToSrgb(clamp01(lr)), linearToSrgb(clamp01(lg)), linearToSrgb(clamp01(lb))];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 8-bit sRGB → linear, via a 256-entry table.
 *
 * Every source pixel goes through this, so the table matters; it holds exactly
 * the values `srgbToLinear(i / 255)` would return, so it changes nothing about
 * the result. Rust builds the identical table.
 */
const SRGB8_TO_LINEAR: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

/** 8-bit sRGB → linear sRGB (0..1). */
export function srgb8ToLinear(c: number): number {
  return SRGB8_TO_LINEAR[c];
}

/** 8-bit sRGB → Oklab. The pipeline's normal entry point. */
export function srgb8ToOklab(r: number, g: number, b: number): Oklab {
  return linearSrgbToOklab(SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]);
}

/** Oklab → 8-bit sRGB, rounded half-up and clamped. */
export function oklabToSrgb8(c: Oklab): [r: number, g: number, b: number] {
  const [r, g, b] = oklabToSrgb(c);
  return [to8(r), to8(g), to8(b)];
}

function to8(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Squared Euclidean distance in Oklab.
 *
 * Squared, not rooted: nearest-colour only ever compares distances, and the
 * square root is both wasted work and an extra place for the two
 * implementations' libms to disagree.
 *
 * Callers comparing against a running best must use the D12 tie-break
 * (`d < best - 1e-9`) so near-ties resolve to the lowest palette index
 * identically in both languages — see `docs/04` §4.2.
 */
export function distanceSq(x: Oklab, y: Oklab): number {
  const dl = x.l - y.l;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return dl * dl + da * da + db * db;
}

/**
 * The tie-break epsilon from D12, in squared-Oklab units.
 *
 * ~3.2e-5 in Oklab distance against a JND of ~0.002, so it can never change a
 * visible choice; ~10^6 times the 6.7e-16 cross-language float residual it
 * exists to absorb.
 */
export const NEAREST_EPSILON = 1e-9;
