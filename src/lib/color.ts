/**
 * Small colour helpers for the UI layer (`docs/02-architecture.md` §4).
 *
 * Deliberately *not* colour science: all perceptual work — distance, nearest
 * colour, error diffusion — happens in Oklab in `pipeline/oklab.ts`, which
 * lands in Phase 2 and is mirrored bit-for-bit in Rust (D10). Nothing here may
 * grow into a second, incompatible notion of colour distance.
 */

import type { RGBA } from '../model/types';

/** `#RRGGBB`, uppercase. Alpha is deliberately not encoded. */
export function toHex(c: RGBA): string {
  const part = (v: number) => v.toString(16).padStart(2, '0');
  return `#${part(c[0])}${part(c[1])}${part(c[2])}`.toUpperCase();
}

/** A CSS colour for swatches and previews. */
export function toCss(c: RGBA): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
}

/** Compares RGB only — a swatch matches the current colour regardless of alpha. */
export function sameRgb(a: RGBA, b: RGBA): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
