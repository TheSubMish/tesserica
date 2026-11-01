/**
 * Colour-space maths for the colour picker only (`panels/ColorPicker.tsx`).
 *
 * This is UI plumbing — where on a wheel a colour sits — not colour science.
 * The Oklch conversions delegate to `pipeline/oklab.ts`, so the picker's idea
 * of "perceptual" is the same Oklab the converter quantizes in.
 */

import type { RGBA } from '../model/types';
import { oklabToLinearSrgb, srgb8ToOklab, linearToSrgb } from '../pipeline/oklab';

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** Lightness [0, 1], chroma [0, ~0.4], hue in degrees [0, 360). */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const wrapHue = (h: number): number => ((h % 360) + 360) % 360;
const to8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export function rgbToHsv(c: RGBA | readonly [number, number, number]): Hsv {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: wrapHue(h * 60), s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + wrapHue(h) / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [to8(f(5) * 255), to8(f(3) * 255), to8(f(1) * 255)];
}

/** The largest chroma the picker ever shows; sRGB's gamut peaks near 0.32. */
export const MAX_CHROMA = 0.37;

/**
 * Oklch → sRGB. `inGamut` is false when the colour needs channels outside
 * [0, 1]; the returned channels are then clipped, and a wheel should leave the
 * pixel empty rather than show a colour you cannot actually paint with.
 */
export function oklchToRgb({ l, c, h }: Oklch): {
  rgb: [number, number, number];
  inGamut: boolean;
} {
  const rad = (wrapHue(h) * Math.PI) / 180;
  const [lr, lg, lb] = oklabToLinearSrgb({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) });
  const eps = 1e-4;
  const inGamut = [lr, lg, lb].every((v) => v >= -eps && v <= 1 + eps);
  const enc = (v: number): number => to8(linearToSrgb(Math.max(0, Math.min(1, v))) * 255);
  return { rgb: [enc(lr), enc(lg), enc(lb)], inGamut };
}

export function rgbToOklch(c: RGBA | readonly [number, number, number]): Oklch {
  const { l: L, a, b } = srgb8ToOklab(c[0], c[1], c[2]);
  const chroma = Math.hypot(a, b);
  return { l: L, c: chroma, h: chroma < 1e-4 ? 0 : wrapHue((Math.atan2(b, a) * 180) / Math.PI) };
}

/** The largest in-gamut chroma at this lightness and hue (bisection). */
export function maxChromaFor(l: number, h: number): number {
  let lo = 0;
  let hi = MAX_CHROMA;
  if (oklchToRgb({ l, c: hi, h }).inGamut) return hi;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (oklchToRgb({ l, c: mid, h }).inGamut) lo = mid;
    else hi = mid;
  }
  return lo;
}

export type HarmonyId = 'complementary' | 'analogous' | 'triadic' | 'split' | 'tetradic' | 'shades';

export const HARMONIES: readonly { id: HarmonyId; label: string }[] = [
  { id: 'complementary', label: 'Complementary' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'triadic', label: 'Triadic' },
  { id: 'split', label: 'Split-complementary' },
  { id: 'tetradic', label: 'Tetradic' },
  { id: 'shades', label: 'Shades' },
];

const HUE_OFFSETS: Record<Exclude<HarmonyId, 'shades'>, readonly number[]> = {
  complementary: [0, 180],
  analogous: [-30, 0, 30],
  triadic: [0, 120, 240],
  split: [0, 150, 210],
  tetradic: [0, 90, 180, 270],
};

/**
 * A harmony scheme built around `base`, as opaque RGB. Hue rotation happens in
 * HSV, which is what an artist expects from a wheel; `shades` instead steps
 * value so a ramp can be started from one click.
 */
export function harmonyColors(base: Hsv, id: HarmonyId): [number, number, number][] {
  if (id === 'shades') {
    return [0.2, 0.4, 0.6, 0.8, 1].map((v) =>
      hsvToRgb({ ...base, v: Math.max(0.05, v * Math.max(base.v, 0.2)) }),
    );
  }
  return HUE_OFFSETS[id].map((d) => hsvToRgb({ ...base, h: base.h + d }));
}
