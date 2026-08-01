/**
 * Bead / cross-stitch pattern chart — color-key/legend computation
 * (`docs/08-roadmap.md` Phase 7 "Bead / cross-stitch chart export (W9)",
 * `docs/06-workflows.md` W9, `docs/01-reference-analysis.md` §5).
 *
 * W9's own line is the design brief: "Nearly free given an indexed grid plus
 * a palette." Indexed color mode (just landed) makes that literally true for
 * an `indexed`-mode sprite — `sprite.palette` already *is* the color key, and
 * every pixel already resolves to one of its entries. An `'rgba'`-mode
 * sprite has no such grid, so one is derived here: the sprite is flattened
 * (`canvas/flatten.ts`, the same composite export uses) and its colors are
 * quantized down to a small palette with the conversion pipeline's own
 * machinery (`pipeline/autopalette.ts::autoPalette` for the palette,
 * `pipeline/quantize.ts::nearestIndexOklab` for the per-pixel snap) rather
 * than a third quantizer. `autoPalette` is called with a hard cap
 * (`DEFAULT_MAX_DERIVED_COLORS`) precisely so an RGBA sprite with thousands
 * of anti-aliased colors cannot produce a legend nobody could print or bead
 * — the whole point of a chart is a genuinely small, discrete color set.
 *
 * This module only computes the grid + legend; the printable image itself is
 * `src-tauri/src/commands/pattern_chart.rs` (full-resolution print output
 * belongs in Rust per `docs/02-architecture.md` §3 — "Rust produces what you
 * ship"). The grid this module produces travels to Rust as a plain JSON
 * array of small integers, the same way `export/tilemapExport.ts`'s packed
 * tile-id grid already does — not a pixel buffer, so it does not trip the
 * "never send pixel buffers through IPC" rule.
 */

import { flattenSprite } from '../canvas/flatten';
import { bufferFrom } from '../pipeline/buffer';
import { autoPalette } from '../pipeline/autopalette';
import { srgb8ToOklab } from '../pipeline/oklab';
import { nearestIndexOklab, preparePalette } from '../pipeline/quantize';
import type { RGBA, Sprite } from './types';

/** Cap on how many colors an RGBA-mode sprite's chart derives. Ignored for indexed sprites. */
export const DEFAULT_MAX_DERIVED_COLORS = 32;

/**
 * A pixel below this alpha counts as an empty chart cell (no bead/stitch
 * there) rather than being snapped to the nearest palette entry. `128` is
 * the same "half or more opaque counts as opaque" default the conversion
 * pipeline itself uses (`pipeline/settings.ts`'s own `alphaThreshold: 128`).
 */
export const PATTERN_CHART_ALPHA_THRESHOLD = 128;

export interface PatternChartLegendEntry {
  /** 0-based position in the legend — the same value `PatternChartData.grid` uses for cells of this color. */
  position: number;
  color: RGBA;
  /** How many chart cells use this color. */
  count: number;
}

export interface PatternChartData {
  width: number;
  height: number;
  /**
   * Row-major, `width * height` entries. Each is either an index into
   * `legend` (by `position`) or `-1` for an empty cell (source pixel was
   * transparent/near-transparent).
   */
  grid: Int32Array;
  /** Ordered by descending count (most-used color first), then ascending original palette index for determinism. */
  legend: PatternChartLegendEntry[];
  /** `true` when the palette was derived from the flattened composite (RGBA-mode sprite); `false` when it is the sprite's own indexed palette. */
  derived: boolean;
}

export interface PatternChartOptions {
  /** Cap on derived colors for an RGBA-mode sprite (`autoPalette`'s `maxColors`). Ignored for indexed sprites. */
  maxColors?: number;
}

/**
 * Build the color-key grid + legend for one frame of `sprite`.
 *
 * **RGBA vs. indexed handling**: an indexed-mode sprite with a non-empty
 * palette uses that palette directly and verbatim — it is already the
 * user's own deliberate, small color set, so nothing is re-derived. Every
 * other sprite (RGBA-mode, or an indexed one with a palette not yet
 * assigned) has a palette derived from its own flattened pixels via
 * `autoPalette`, capped at `options.maxColors ?? DEFAULT_MAX_DERIVED_COLORS`
 * colors.
 */
export function buildPatternChart(
  sprite: Sprite,
  frameId: string,
  options: PatternChartOptions = {},
): PatternChartData {
  const composite = flattenSprite(sprite, frameId);
  const buf = bufferFrom(sprite.width, sprite.height, composite);

  let paletteColors: RGBA[];
  let derived: boolean;
  if (sprite.colorMode === 'indexed' && sprite.palette && sprite.palette.colors.length > 0) {
    paletteColors = sprite.palette.colors;
    derived = false;
  } else {
    const maxColors = options.maxColors ?? DEFAULT_MAX_DERIVED_COLORS;
    paletteColors = autoPalette(buf, maxColors, PATTERN_CHART_ALPHA_THRESHOLD);
    derived = true;
  }

  const prepared = preparePalette(paletteColors);
  const rawGrid = new Int32Array(sprite.width * sprite.height).fill(-1);
  const counts = new Map<number, number>();

  for (let p = 0, i = 0; p < rawGrid.length; p++, i += 4) {
    const a = buf.data[i + 3];
    if (a < PATTERN_CHART_ALPHA_THRESHOLD) continue;
    const lab = srgb8ToOklab(buf.data[i], buf.data[i + 1], buf.data[i + 2]);
    const idx = nearestIndexOklab(prepared, lab);
    rawGrid[p] = idx;
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }

  // Most-used color first — the conventional cross-stitch/bead chart legend
  // order — with a deterministic tie-break so two colors of equal count
  // always land in the same order.
  const usedIndices = [...counts.keys()].sort((x, y) => {
    const byCount = (counts.get(y) as number) - (counts.get(x) as number);
    return byCount !== 0 ? byCount : x - y;
  });

  const remap = new Map<number, number>();
  const legend: PatternChartLegendEntry[] = usedIndices.map((origIdx, position) => {
    remap.set(origIdx, position);
    return { position, color: paletteColors[origIdx], count: counts.get(origIdx) as number };
  });

  const grid = new Int32Array(rawGrid.length);
  for (let p = 0; p < rawGrid.length; p++) {
    const orig = rawGrid[p];
    grid[p] = orig === -1 ? -1 : (remap.get(orig) as number);
  }

  return { width: sprite.width, height: sprite.height, grid, legend, derived };
}
