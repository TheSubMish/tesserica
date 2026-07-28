/**
 * Flood fill — contiguous and global (`docs/05-ui-design.md` §4.1).
 *
 * **Colour matching is exact.** A tolerance slider is a colour *distance*, and
 * every colour distance in this project is computed in Oklab
 * (`docs/04-image-pipeline.md` §4, locked invariant). `oklab.ts` does not
 * exist until Phase 2, and hand-rolling an sRGB metric here would both
 * contradict that invariant and create a second, incompatible notion of
 * "close colours". Tolerance therefore lands with Oklab in Phase 2; exact
 * match is what a pixel artist wants on hand-drawn art anyway, where there is
 * no sensor noise to absorb.
 *
 * The contiguous fill is a scanline flood: it walks whole runs rather than
 * pushing four neighbours per pixel, which keeps the stack proportional to
 * the number of runs instead of the number of pixels.
 */

import { setPixel } from '../model/pixelBuffers';
import { rectContains, type Rect } from '../model/rect';
import type { RGBA } from '../model/types';

function sameColor(buf: Uint8ClampedArray, i: number, c: readonly number[]): boolean {
  return buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === c[3];
}

function readColor(buf: Uint8ClampedArray, i: number): [number, number, number, number] {
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/**
 * `clip`, when given, confines the fill to a selection (`docs/08-roadmap.md`
 * Phase 3) — global fill only recolours matching pixels inside it, and
 * contiguous fill cannot flood out through its boundary.
 */
export function fillGlobal(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  color: RGBA,
  clip?: Rect | null,
): void {
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return;
  if (clip && !rectContains(clip, seedX, seedY)) return;
  const target = readColor(buf, (seedY * width + seedX) * 4);
  if (target.every((v, k) => v === color[k])) return;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (clip && !rectContains(clip, x, y)) continue;
      const i = (y * width + x) * 4;
      if (!sameColor(buf, i, target)) continue;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = color[3];
    }
  }
}

/** Replace the 4-connected region of the seed's colour. */
export function fillContiguous(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  color: RGBA,
  clip?: Rect | null,
): void {
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return;
  if (clip && !rectContains(clip, seedX, seedY)) return;

  const target = readColor(buf, (seedY * width + seedX) * 4);
  // Filling a region with the colour it already has would never terminate.
  if (target.every((v, k) => v === color[k])) return;

  const matches = (x: number, y: number): boolean =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    (!clip || rectContains(clip, x, y)) &&
    sameColor(buf, (y * width + x) * 4, target);

  const stack: { x: number; y: number }[] = [{ x: seedX, y: seedY }];

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (!matches(x, y)) continue;

    let left = x;
    while (matches(left - 1, y)) left--;
    let right = x;
    while (matches(right + 1, y)) right++;

    for (let px = left; px <= right; px++) setPixel(buf, width, height, px, y, color);

    // Seed the rows above and below once per contiguous run rather than once
    // per pixel.
    for (const ny of [y - 1, y + 1]) {
      let inRun = false;
      for (let px = left; px <= right; px++) {
        if (matches(px, ny)) {
          if (!inRun) {
            stack.push({ x: px, y: ny });
            inRun = true;
          }
        } else {
          inRun = false;
        }
      }
    }
  }
}
