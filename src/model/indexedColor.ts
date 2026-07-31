/**
 * The "user picked a colour not in the palette" policy `docs/10-decisions.md`
 * D9 names explicitly as unresolved for indexed mode.
 *
 * **Policy: snap to the nearest palette colour, in Oklab.** Reuses the exact
 * nearest-colour search the conversion pipeline already relies on
 * (`src/pipeline/quantize.ts::nearestIndexOklab`, `docs/04-image-pipeline.md`
 * §4 — "all colour distance happens in Oklab", a locked invariant) rather than
 * hand-rolling a second one. The alternatives — refuse the paint, or grow the
 * palette to fit — were rejected: refusing is hostile for a tool whose whole
 * point is to let the user keep picking colours from the same RGB picker
 * every other mode uses, and silently growing the palette would make
 * "swap the palette" (the actual feature) unpredictable, since painting could
 * have quietly changed what the palette even contains.
 *
 * Alpha is a second, independent axis: any colour with alpha `0` always
 * resolves to `TRANSPARENT_INDEX` (`model/indexBuffers.ts`) regardless of its
 * RGB, and any non-zero alpha resolves to a palette entry — indexed storage
 * has no notion of a pixel's own partial alpha beyond what the palette entry
 * itself carries, which is the genuine constraint of one-byte-per-pixel
 * storage (`docs/03-data-model.md` §3, "Indexed color mode stores palette
 * indices instead of RGBA").
 */

import { preparePalette, nearestIndexOklab, type PreparedPalette } from '../pipeline/quantize';
import { srgb8ToOklab } from '../pipeline/oklab';
import { TRANSPARENT_INDEX } from './indexBuffers';
import type { Palette, RGBA } from './types';

/**
 * A prepared palette (its Oklab conversion done once) is cheap to reuse
 * across an entire stroke but not free to build — `preparePalette` maps every
 * entry through `srgb8ToOklab`. Painting calls `nearestPaletteIndex` once per
 * pixel, so a one-entry memo keyed on the `Palette` object's own identity
 * keeps a brush stroke from re-preparing the same palette on every pixel.
 */
let cache: { palette: Palette; prepared: PreparedPalette } | null = null;

function prepared(palette: Palette): PreparedPalette {
  if (cache && cache.palette === palette) return cache.prepared;
  const prepared = preparePalette(palette.colors);
  cache = { palette, prepared };
  return prepared;
}

/**
 * Resolve an RGBA colour to a raw index into `palette` — `TRANSPARENT_INDEX`
 * for alpha `0`, otherwise the nearest colour's index in `palette.colors`
 * shifted up by one to leave room for the reserved transparent slot.
 */
export function nearestPaletteIndex(color: RGBA, palette: Palette): number {
  if (color[3] === 0) return TRANSPARENT_INDEX;
  if (palette.colors.length === 0) return TRANSPARENT_INDEX;
  const lab = srgb8ToOklab(color[0], color[1], color[2]);
  return nearestIndexOklab(prepared(palette), lab) + 1;
}

/** Resolve a raw stored index back to displayable RGBA — the inverse of `nearestPaletteIndex`. */
export function resolveIndexToRgba(index: number, palette: Palette): RGBA {
  if (index === TRANSPARENT_INDEX) return [0, 0, 0, 0];
  const entry = palette.colors[index - 1];
  return entry ?? [0, 0, 0, 0]; // defensive: an index past the palette's own length
}

/**
 * A cheap string fingerprint of a palette's actual colours — used by the
 * renderer/compositor caches (`canvas/renderer.ts`) to invalidate whenever a
 * palette a document depends on changes, which is what makes live palette
 * swapping "instant" rather than requiring a manual redraw.
 */
export function paletteFingerprint(palette: Palette | undefined): string {
  if (!palette) return '-';
  return `${palette.id}:${palette.colors.map((c) => c.join(',')).join('|')}`;
}
