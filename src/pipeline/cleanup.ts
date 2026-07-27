/**
 * Stage [6] — cleanup (`docs/04-image-pipeline.md` §6).
 *
 * Mirrors `src-tauri/src/pipeline/cleanup.rs`.
 *
 * Operates on the **index map**, not on RGBA. After quantization the colours are
 * already palette entries, so "is this the same colour as its neighbour" is an
 * integer comparison rather than a distance, and connected components are exact.
 */

import { NEAREST_EPSILON, distanceSq, srgb8ToOklab } from './oklab.ts';
import { TRANSPARENT_INDEX, type PreparedPalette } from './quantize.ts';
import type { OutlineSettings } from './settings.ts';

/**
 * Remove islands of `minArea` pixels or fewer, replacing each with the most
 * common index among its neighbours (§6.1).
 *
 * Three things §6.1 leaves open, settled here and identically in Rust:
 *
 * - **Area threshold is inclusive** — `despeckle: 1` removes single pixels. The
 *   document's "area < despeckle" would make level 1 a no-op, which cannot be
 *   what a 0–3 control means.
 * - **4-connectivity** for components. 8-connectivity would chain diagonal
 *   single-pixel details, which in pixel art are usually deliberate.
 * - **Transparent regions participate**, since `TRANSPARENT_INDEX` is just
 *   another label. That means tiny holes get filled too, which is the same
 *   defect wearing a different colour.
 *
 * One pass: every replacement is decided from the *original* map, so the result
 * does not depend on the order components are visited.
 */
export function despeckle(
  width: number,
  height: number,
  indices: Uint16Array,
  minArea: number,
): Uint16Array {
  if (minArea < 1) return indices;

  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const out = Uint16Array.from(indices);
  const stack: number[] = [];
  const members: number[] = [];
  const neighbourCounts = new Map<number, number>();
  let label = 0;

  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] !== -1) continue;

    const value = indices[seed];
    members.length = 0;
    stack.length = 0;
    stack.push(seed);
    labels[seed] = label;

    while (stack.length > 0) {
      const p = stack.pop() as number;
      members.push(p);
      const x = p % width;
      const y = (p - x) / width;
      const around = [
        x > 0 ? p - 1 : -1,
        x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y + 1 < height ? p + width : -1,
      ];
      for (const q of around) {
        if (q >= 0 && labels[q] === -1 && indices[q] === value) {
          labels[q] = label;
          stack.push(q);
        }
      }
    }

    if (members.length <= minArea) {
      neighbourCounts.clear();
      for (const p of members) {
        const x = p % width;
        const y = (p - x) / width;
        const around = [
          x > 0 ? p - 1 : -1,
          x + 1 < width ? p + 1 : -1,
          y > 0 ? p - width : -1,
          y + 1 < height ? p + width : -1,
        ];
        for (const q of around) {
          if (q < 0 || indices[q] === value) continue;
          neighbourCounts.set(indices[q], (neighbourCounts.get(indices[q]) ?? 0) + 1);
        }
      }
      // Ties go to the lowest index, so the result never depends on map order.
      // TRANSPARENT_INDEX being 0xffff means a real colour always wins a tie
      // against transparency, which is the behaviour you want when erasing
      // noise next to an edge.
      let bestIndex = -1;
      let bestCount = 0;
      for (const [idx, count] of neighbourCounts) {
        if (count > bestCount || (count === bestCount && idx < bestIndex)) {
          bestIndex = idx;
          bestCount = count;
        }
      }
      if (bestIndex >= 0) {
        for (const p of members) out[p] = bestIndex;
      }
    }

    label++;
  }

  return out;
}

/**
 * Add a border around non-transparent regions (§6.2).
 *
 * `thickness` successive one-pixel dilations into transparent space, using
 * 8-connectivity when `corners` is set (rounder corners) and 4-connectivity
 * otherwise.
 *
 * The outline colour is snapped to the **nearest palette entry**: the output is
 * by definition constrained to the palette, and quietly introducing a colour
 * that is not in it would be a worse surprise than the snap. Pick an outline
 * colour that is in the palette.
 */
export function outline(
  width: number,
  height: number,
  indices: Uint16Array,
  alpha: Uint8ClampedArray,
  palette: PreparedPalette,
  settings: OutlineSettings,
): { indices: Uint16Array; alpha: Uint8ClampedArray } {
  const thickness = Math.trunc(settings.thickness);
  if (thickness < 1) return { indices, alpha };

  const outIndices = Uint16Array.from(indices);
  const outAlpha = Uint8ClampedArray.from(alpha);
  const colorIndex = nearestPaletteIndex(palette, settings.color);
  const colorAlpha = settings.color[3];

  for (let ring = 0; ring < thickness; ring++) {
    const previous = Uint16Array.from(outIndices);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (previous[p] !== TRANSPARENT_INDEX) continue;
        if (hasOpaqueNeighbour(previous, width, height, x, y, settings.corners)) {
          outIndices[p] = colorIndex;
          outAlpha[p] = colorAlpha;
        }
      }
    }
  }

  return { indices: outIndices, alpha: outAlpha };
}

function hasOpaqueNeighbour(
  indices: Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  corners: boolean,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (!corners && dx !== 0 && dy !== 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (indices[ny * width + nx] !== TRANSPARENT_INDEX) return true;
    }
  }
  return false;
}

/** Nearest palette entry to a colour, in Oklab, with the D12 tie-break. */
export function nearestPaletteIndex(
  palette: PreparedPalette,
  color: readonly [number, number, number, number],
): number {
  const c = srgb8ToOklab(color[0], color[1], color[2]);
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
