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

/**
 * The inverse of {@link toHex} — `#RRGGBB` (any case) plus an alpha supplied
 * separately, since a native `<input type="color">` (the layer-effects
 * colour fields, roadmap Phase 7) never carries one. Malformed input falls
 * back to opaque black rather than throwing, since a browser colour input
 * cannot actually produce anything but a well-formed 6-digit hex string.
 */
export function fromHex(hex: string, alpha: number): RGBA {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [0, 0, 0, alpha];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, alpha];
}
