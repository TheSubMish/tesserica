/**
 * Stage [3] — colour adjustments (`docs/04-image-pipeline.md` §9).
 *
 * Mirrors `src-tauri/src/pipeline/adjust.rs`.
 *
 * All four happen **in Oklab**, which is the whole point: sRGB saturation boosts
 * blow out hues and sRGB brightness crushes shadows. And they happen **before**
 * quantization (§2.1) so the palette match is made against the colours the user
 * actually intends, once, rather than being re-mapped and compounding error.
 *
 * Order within the stage is brightness → contrast → saturation → hue, matching
 * the order of the fields in §2.2 and §9's table. Order matters here too —
 * contrast after brightness is not the same as before it — so it is fixed and
 * identical in both implementations.
 */

import { bufferFrom, type PixelBuffer } from './buffer.ts';
import { type Oklab, oklabToSrgb8, srgb8ToOklab } from './oklab.ts';
import type { ConvertSettings } from './settings.ts';

export interface AdjustParams {
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 */
  saturation: number;
  /** -180..180 degrees */
  hueShift: number;
}

export function adjustParamsFrom(settings: ConvertSettings): AdjustParams {
  return {
    brightness: settings.brightness,
    contrast: settings.contrast,
    saturation: settings.saturation,
    hueShift: settings.hueShift,
  };
}

/** True when every adjustment is at its neutral value. */
export function isNeutral(p: AdjustParams): boolean {
  return p.brightness === 0 && p.contrast === 0 && p.saturation === 0 && p.hueShift === 0;
}

/** Apply the adjustments to one colour. Exposed for tests and for dither paths. */
export function adjustOklab(c: Oklab, p: AdjustParams): Oklab {
  // Brightness: scale L.
  let l = c.l * (1 + p.brightness);
  // Contrast: expand around mid-lightness.
  l = (l - 0.5) * (1 + p.contrast) + 0.5;

  // Saturation: scale chroma.
  const sat = 1 + p.saturation;
  let a = c.a * sat;
  let b = c.b * sat;

  // Hue: rotate the a/b plane.
  if (p.hueShift !== 0) {
    const rad = (p.hueShift * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ra = a * cos - b * sin;
    const rb = a * sin + b * cos;
    a = ra;
    b = rb;
  }

  return { l, a, b };
}

/**
 * Apply the adjustments to a whole buffer.
 *
 * Alpha is untouched, and fully transparent pixels are adjusted along with
 * everything else — their RGB is meaningless, but branching on alpha here would
 * make the result depend on the threshold, which belongs to a later stage.
 *
 * Neutral settings return the source unchanged rather than round-tripping every
 * pixel through Oklab. That is both faster and safer: an 8-bit → Oklab → 8-bit
 * round trip is exact, but "exact" is a property worth not relying on when the
 * correct answer is to do nothing.
 */
export function applyAdjustments(src: PixelBuffer, p: AdjustParams): PixelBuffer {
  if (isNeutral(p)) return src;

  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    const c = adjustOklab(srgb8ToOklab(src.data[i], src.data[i + 1], src.data[i + 2]), p);
    const [r, g, b] = oklabToSrgb8(c);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = src.data[i + 3];
  }
  return bufferFrom(src.width, src.height, out);
}
