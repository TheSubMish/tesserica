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
import { selectionContains, selectionFromMask, type Selection } from '../model/selection';

/** `bpp` bytes starting at `i` match `c` exactly. */
function sameColor(
  buf: Uint8ClampedArray | Uint8Array,
  i: number,
  c: readonly number[],
  bpp: number,
): boolean {
  for (let k = 0; k < bpp; k++) if (buf[i + k] !== c[k]) return false;
  return true;
}

function readColor(buf: Uint8ClampedArray | Uint8Array, i: number, bpp: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < bpp; k++) out.push(buf[i + k]);
  return out;
}

/**
 * `clip`, when given, confines the fill to a selection (`docs/08-roadmap.md`
 * Phase 3) — global fill only recolours matching pixels inside it, and
 * contiguous fill cannot flood out through its boundary.
 */
export function fillGlobal(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  value: readonly number[],
  clip?: Selection | null,
): void {
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return;
  if (!selectionContains(clip, seedX, seedY)) return;
  const bpp = value.length;
  const target = readColor(buf, (seedY * width + seedX) * bpp, bpp);
  if (target.every((v, k) => v === value[k])) return;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!selectionContains(clip, x, y)) continue;
      const i = (y * width + x) * bpp;
      if (!sameColor(buf, i, target, bpp)) continue;
      for (let k = 0; k < bpp; k++) buf[i + k] = value[k];
    }
  }
}

/** Replace the 4-connected region of the seed's colour. */
export function fillContiguous(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  value: readonly number[],
  clip?: Selection | null,
): void {
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return;
  if (!selectionContains(clip, seedX, seedY)) return;

  const bpp = value.length;
  const target = readColor(buf, (seedY * width + seedX) * bpp, bpp);
  // Filling a region with the colour it already has would never terminate.
  if (target.every((v, k) => v === value[k])) return;

  const matches = (x: number, y: number): boolean =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    selectionContains(clip, x, y) &&
    sameColor(buf, (y * width + x) * bpp, target, bpp);

  walkContiguousRuns(width, height, seedX, seedY, matches, (left, right, y) => {
    for (let px = left; px <= right; px++) setPixel(buf, width, height, px, y, value);
  });
}

/**
 * Scanline contiguous-region walk shared by `fillContiguous` and
 * `wandSelection` — the geometry of "find every pixel 4-connected to the
 * seed that matches" is identical; only what happens to a matching run
 * differs (paint it, versus mark it in a mask).
 *
 * Tracks its own `visited` set rather than relying on `visitRun` to make a
 * pixel stop matching. `fillContiguous`'s callback happens to do that too
 * (painting a pixel a different colour makes it fail `matches` on a later
 * scan), but `wandSelection`'s callback only marks a mask — it never touches
 * the buffer `matches` reads from, so without an explicit `visited` set the
 * walk would revisit the same run forever.
 */
function walkContiguousRuns(
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  matches: (x: number, y: number) => boolean,
  visitRun: (left: number, right: number, y: number) => void,
): void {
  const visited = new Uint8Array(width * height);
  const test = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && !visited[y * width + x] && matches(x, y);

  const stack: { x: number; y: number }[] = [{ x: seedX, y: seedY }];

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (!test(x, y)) continue;

    let left = x;
    while (test(left - 1, y)) left--;
    let right = x;
    while (test(right + 1, y)) right++;

    for (let px = left; px <= right; px++) visited[y * width + px] = 1;
    visitRun(left, right, y);

    // Seed the rows above and below once per contiguous run rather than once
    // per pixel.
    for (const ny of [y - 1, y + 1]) {
      let inRun = false;
      for (let px = left; px <= right; px++) {
        if (test(px, ny)) {
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

/**
 * Magic wand — select the 4-connected region matching the seed pixel's exact
 * colour (`docs/05-ui-design.md` §4.1 lists it under "Select"; the same exact-
 * match rationale as `fillContiguous` applies — Oklab tolerance is future
 * work, not a v1 gap this tool needs to solve alone).
 *
 * Operates on the active layer's raw cel, like the bucket does, not the
 * composited image — consistent with every other paint tool's clip
 * semantics.
 *
 * `bytesPerPixel` defaults to 4 (RGBA) — every pre-Phase-7 call site is
 * unaffected; an indexed-mode cel (`docs/08-roadmap.md` Phase 7) passes 1.
 */
export function wandSelection(
  buf: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  bytesPerPixel = 4,
): Selection | null {
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return null;

  const target = readColor(buf, (seedY * width + seedX) * bytesPerPixel, bytesPerPixel);
  const matches = (x: number, y: number): boolean =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    sameColor(buf, (y * width + x) * bytesPerPixel, target, bytesPerPixel);

  const mask = new Uint8Array(width * height);
  walkContiguousRuns(width, height, seedX, seedY, matches, (left, right, y) => {
    for (let px = left; px <= right; px++) mask[y * width + px] = 1;
  });

  return selectionFromMask({ x: 0, y: 0, width, height }, mask);
}
