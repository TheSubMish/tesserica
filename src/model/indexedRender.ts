/**
 * Resolve an indexed cel's stored indices through its sprite's palette into
 * displayable straight-alpha RGBA — the indexed-mode counterpart to
 * `model/tilemapRender.ts::renderTilemapCel` (same "different buffer, same
 * `Cel` shape, resolved at composite time" pattern `docs/03-data-model.md`
 * §2.2's implementation note already established for tilemap cels).
 *
 * This is the one function `canvas/flatten.ts`, `canvas/renderer.ts` and
 * `canvas/sample.ts` all call to turn an indexed cel's bytes into pixels, so
 * export, the live canvas and the eyedropper can never disagree about what an
 * index means.
 */

import { resolveIndexToRgba } from './indexedColor';
import type { Palette } from './types';

export function renderIndexedCel(
  indices: Uint8Array,
  palette: Palette | undefined,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (!palette) return out; // no palette assigned — render as fully transparent rather than guess
  for (let p = 0; p < indices.length; p++) {
    const [r, g, b, a] = resolveIndexToRgba(indices[p], palette);
    const i = p * 4;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}
